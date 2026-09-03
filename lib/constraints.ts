/**
 * lib/constraints.ts —— 规则引擎(technical-spec §7 的 L3 规则层)
 *
 * 纯函数模块:不碰网络、不碰 LLM、不碰 Supabase、不读系统时钟。
 * 所有日期由入参的 start_date + day 推导,因此结果与运行环境时区无关。
 *
 * 对应 §7 的三个步骤:
 *   第 2 步  buildConstraints    —— 把 trip + preferences 折叠成一份硬约束
 *   第 3 步  filterCandidates    —— 从 places 里筛出当天可用的候选
 *   第 7 步  validateItinerary   —— 后置硬校验(防 LLM 幻觉的核心)
 *            enforceBudget       —— 超预算时砍非 locked 的 block
 *
 * 类型来源说明:lib/schemas.ts(Zod,Sep 5 冻结)定稿后,下面这些 input 类型
 * 应改为从那里 import type 再 re-export,本文件不再自带定义。
 */

// ---------------------------------------------------------------------------
// 输入类型(对齐 §5 数据库 schema)
// ---------------------------------------------------------------------------

export type Pace = 'chill' | 'balanced' | 'packed';
export type BudgetBand = 'low' | 'mid' | 'high';

export interface Trip {
  id: string;
  slug: string;
  destination: string;
  city_key: string;
  /** 'YYYY-MM-DD' */
  start_date: string;
  /** 'YYYY-MM-DD' */
  end_date: string;
  budget_per_person: number;
}

export interface Preference {
  member_id: string;
  trip_id: string;
  budget_band: BudgetBand | null;
  pace: Pace | null;
  interests: string[] | null;
  dietary: string[] | null;
  /** schema 里是 text 不是 text[],可能塞了多项,按分隔符拆 */
  must_do: string | null;
  no_go: string | null;
}

/** 0 = 周日 … 6 = 周六 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface TimeRange {
  /** 'HH:MM' */
  open: string;
  /** 'HH:MM';close <= open 视为跨夜(+24h),也接受 '25:30' 这种写法 */
  close: string;
}

/** places.opening_hours(jsonb)的约定形状 */
export interface OpeningHours {
  /** 该 weekday 键缺失或为空数组 = 当天不营业 */
  periods?: Partial<Record<Weekday, TimeRange[]>>;
  /** 'YYYY-MM-DD' → 覆盖 periods,用于公休日 */
  exceptions?: Record<string, TimeRange[]>;
  always_open?: boolean;
}

export interface Place {
  id: string;
  city_key: string;
  name: string;
  category: string | null;
  district: string | null;
  lat: number | null;
  lng: number | null;
  /** null 或结构不可解析 = 数据缺失 → 当作全天开放(见 §11 容错) */
  opening_hours: OpeningHours | null;
  est_cost_per_person: number | null;
  avg_duration_min: number | null;
  indoor: boolean;
  veg_friendly: boolean;
}

export interface Block {
  id: string;
  /** 1-based:第几天 */
  day: number;
  /** 'HH:MM' 或 'HH:MM:SS'(Postgres time 出来是后者) */
  start_time: string;
  duration_min: number;
  title: string;
  subtitle?: string | null;
  place_id: string | null;
  cost_per_person: number;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

export interface Constraints {
  city_key: string;
  /** 'YYYY-MM-DD' */
  start_date: string;
  /** end_date - start_date + 1,最小为 1 */
  days: number;
  /** 人均花费上限,取全员最低 */
  budget_ceiling: number;
  blocks_per_day: number;
  /** 判定出的 pace,写进 block.reason 用 */
  pace: Pace;
  /** 以下三组存去过空格的原文(保留大小写),比对时才内部归一化 */
  required_tags: string[];
  forced: string[];
  excluded: string[];
}

export type ViolationCode =
  /** place_id 不在候选列表 —— 防 LLM 发明地点,§7 第 7 步的头一条 */
  | 'unknown_place'
  | 'missing_place'
  | 'over_budget'
  | 'overlap'
  | 'outside_opening_hours'
  | 'closed_that_day'
  | 'missing_forced'
  | 'invalid_day'
  | 'invalid_time';

export interface Violation {
  code: ViolationCode;
  /** 人读的说明,可直接进 UI */
  message: string;
  block_id?: string;
  day?: number;
  detail?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

// ---------------------------------------------------------------------------
// 可调常量
// ---------------------------------------------------------------------------

export const BLOCKS_PER_PACE: Readonly<Record<Pace, number>> = {
  chill: 3,
  balanced: 4,
  packed: 5,
};

/** budget_band → 人均花费上限(绝对金额,单位同 trips.budget_per_person) */
export const BAND_CEILING: Readonly<Record<BudgetBand, number>> = {
  low: 800,
  mid: 1500,
  high: 2500,
};

/** band 缺失时按哪一档算 */
const FALLBACK_BAND: BudgetBand = 'mid';

/** must_do / no_go 是自由文本,按常见分隔符拆成多项 */
const FREE_TEXT_SEPARATORS = /[,，、;；\n\r]+/;

export interface BuildConstraintsOptions {
  bandCeiling?: Record<BudgetBand, number>;
  blocksPerPace?: Record<Pace, number>;
  /** pace 平票或全员未填时用哪一档,默认 'balanced' */
  defaultPace?: Pace;
  splitFreeText?: (value: string) => string[];
}

export interface FilterOptions {
  /** excluded 拿去比对 place 的哪些字段,默认 ['category', 'name'] */
  matchExcludedAgainst?: ReadonlyArray<'category' | 'name' | 'district'>;
}

export interface EnforceBudgetOptions {
  /** true 时命中 forced 的 block 排到最后才砍,默认 false(照 §7 字面) */
  protectForced?: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const PACES: readonly Pace[] = ['chill', 'balanced', 'packed'];
const BANDS: readonly BudgetBand[] = ['low', 'mid', 'high'];
const MINUTES_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;

function isPace(value: unknown): value is Pace {
  return typeof value === 'string' && (PACES as readonly string[]).includes(value);
}

function isBand(value: unknown): value is BudgetBand {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 同样是判空对象,但【不做类型收窄】——用在已有静态类型、只是来源不可信的值上
 * (Supabase / LLM 出来的数组里可能混进 null),收窄成 Record 反而会丢掉原类型。
 */
function isFilled(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * 把来源不可信的入参收成数组。注意不能在调用点直接写 Array.isArray(xs) ——
 * 对 readonly T[] 它会把类型收窄成 any[],下游全部退化成 any。
 */
function asArray<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 比对用的归一化:去首尾空格、小写、内部连续空白压成一个空格 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 太短的比对 token 会误伤(no_go 写个 'b' 会把所有 bar 全剔掉)。
 * ASCII 单字符一律忽略;CJK 单字(「酒」「鱼」)是有意义的,保留。
 */
function isUsableToken(token: string): boolean {
  return token.length >= 2 || /[^\x00-\x7f]/.test(token);
}

/** 去空、去重(大小写不敏感),保留首次出现的原文 */
function dedupe(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function defaultSplitFreeText(value: string): string[] {
  return value.split(FREE_TEXT_SEPARATORS);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// --- 时间 -----------------------------------------------------------------

const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** 'HH:MM' / 'HH:MM:SS' → 距零点的分钟数;允许 24–47 时表示跨夜。解析不了返回 null */
function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = CLOCK_RE.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 47 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(totalMinutes: number): string {
  const m = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// --- 日期(纯 UTC 运算,不受本地时区影响) --------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseISODate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const ms = Date.UTC(year, month - 1, dayOfMonth);
  if (!Number.isFinite(ms)) return null;
  // 反查一遍,挡掉 2 月 30 号这种被 Date.UTC 自动进位的日期
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return ms;
}

interface CalendarDay {
  /** 'YYYY-MM-DD' */
  iso: string;
  weekday: Weekday;
}

function calendarDay(startMs: number, dayIndex: number): CalendarDay {
  const dt = new Date(startMs + (dayIndex - 1) * MS_PER_DAY);
  const iso =
    `${String(dt.getUTCFullYear()).padStart(4, '0')}-` +
    `${String(dt.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(dt.getUTCDate()).padStart(2, '0')}`;
  return { iso, weekday: dt.getUTCDay() as Weekday };
}

/** 从 constraints 推出第 day 天是哪一天;start_date 不可解析时返回 null */
function dayOf(constraints: Constraints, day: number): CalendarDay | null {
  const startMs = parseISODate(constraints?.start_date);
  if (startMs === null || !Number.isInteger(day)) return null;
  return calendarDay(startMs, day);
}

// --- 营业时间 -------------------------------------------------------------

interface Interval {
  start: number;
  end: number;
}

/**
 * 当天的营业时段。
 *   null → 数据缺失/不可解析,视为全天开放(宁可留下让 LLM 挑,也不能把候选池洗空)
 *   []   → 当天休息
 */
function rangesForDay(place: Place, when: CalendarDay | null): Interval[] | null {
  const oh: unknown = place.opening_hours;
  if (!isObject(oh)) return null;
  if (oh['always_open'] === true) return null;

  let raw: unknown;
  let matched = false;

  const exceptions = oh['exceptions'];
  if (when && isObject(exceptions) && Object.prototype.hasOwnProperty.call(exceptions, when.iso)) {
    raw = exceptions[when.iso];
    matched = true;
  }

  const periods = oh['periods'];
  if (!matched && when && isObject(periods)) {
    const key = String(when.weekday);
    if (Object.prototype.hasOwnProperty.call(periods, key)) {
      raw = periods[key];
      matched = true;
    } else {
      // periods 写了,但没有这一天 → 当天休息
      return [];
    }
  }

  if (!matched) return null;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];

  const intervals: Interval[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const start = parseClock(entry['open']);
    let end = parseClock(entry['close']);
    if (start === null || end === null) continue;
    if (end <= start) end += MINUTES_PER_DAY; // 跨夜:18:00–02:00
    intervals.push({ start, end });
  }
  // 写了时段但一条都解析不出来 → 当作未知,别误杀
  return intervals.length > 0 ? intervals : null;
}

/** [start, end] 必须整段落在某一个营业时段内 */
function isOpenDuring(ranges: Interval[] | null, start: number, end: number): boolean {
  if (ranges === null) return true;
  if (ranges.length === 0) return false;
  return ranges.some(
    (r) =>
      (start >= r.start && end <= r.end) ||
      // 凌晨的 block 可能属于前一段跨夜营业(00:30 落在 18:00–26:00 里)
      (start + MINUTES_PER_DAY >= r.start && end + MINUTES_PER_DAY <= r.end),
  );
}

// ---------------------------------------------------------------------------
// 1. buildConstraints
// ---------------------------------------------------------------------------

/**
 * 把 trip + 全体 preferences 折叠成一份硬约束(§7 第 2 步)。
 *
 * - budget_ceiling 取全员【最低】,不是平均
 * - blocks_per_day 由唯一众数 pace 决定;平票或全员未填 → defaultPace
 * - required_tags / forced / excluded 分别是 dietary / must_do / no_go 的并集
 */
export function buildConstraints(
  trip: Trip,
  preferences: readonly Preference[] = [],
  opts: BuildConstraintsOptions = {},
): Constraints {
  const bandCeiling = opts.bandCeiling ?? BAND_CEILING;
  const blocksPerPace = opts.blocksPerPace ?? BLOCKS_PER_PACE;
  const defaultPace = isPace(opts.defaultPace) ? opts.defaultPace : 'balanced';
  const split = opts.splitFreeText ?? defaultSplitFreeText;

  const prefs = asArray(preferences).filter((p) => isFilled(p));

  // --- budget_ceiling:取最低那位 ---
  let lowest: number | null = null;
  for (const p of prefs) {
    const band = isBand(p.budget_band) ? p.budget_band : FALLBACK_BAND;
    const value = bandCeiling[band];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    lowest = lowest === null ? value : Math.min(lowest, value);
  }
  // 一条 preference 都没有时没有 band 可取,只能回落到 trip 的人均预算
  const budget_ceiling =
    lowest ?? finiteOr(trip?.budget_per_person, finiteOr(bandCeiling[FALLBACK_BAND], 0));

  // --- pace:唯一众数,平票回落 defaultPace ---
  const tally: Record<Pace, number> = { chill: 0, balanced: 0, packed: 0 };
  for (const p of prefs) {
    if (isPace(p.pace)) tally[p.pace] += 1;
  }
  const top = Math.max(tally.chill, tally.balanced, tally.packed);
  const leaders = PACES.filter((k) => tally[k] === top);
  const pace: Pace = top > 0 && leaders.length === 1 ? leaders[0]! : defaultPace;
  const blocks_per_day = finiteOr(
    blocksPerPace[pace],
    finiteOr(BLOCKS_PER_PACE[pace], BLOCKS_PER_PACE.balanced),
  );

  // --- 三组标签 ---
  const splitAll = (values: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const pieces = split(value);
      if (!Array.isArray(pieces)) continue;
      for (const piece of pieces) out.push(piece);
    }
    return out;
  };

  const required_tags = dedupe(splitAll(prefs.flatMap((p) => toStringArray(p.dietary))));
  const forced = dedupe(
    splitAll(prefs.map((p) => p.must_do).filter((v): v is string => typeof v === 'string')),
  );
  const excluded = dedupe(
    splitAll(prefs.map((p) => p.no_go).filter((v): v is string => typeof v === 'string')),
  );

  // --- 天数 ---
  const startMs = parseISODate(trip?.start_date);
  const endMs = parseISODate(trip?.end_date);
  const days =
    startMs !== null && endMs !== null
      ? Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY) + 1)
      : 1;

  return {
    city_key: typeof trip?.city_key === 'string' ? trip.city_key : '',
    start_date: typeof trip?.start_date === 'string' ? trip.start_date : '',
    days,
    budget_ceiling,
    blocks_per_day,
    pace,
    required_tags,
    forced,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// 2. filterCandidates
// ---------------------------------------------------------------------------

function matchesExcluded(
  place: Place,
  tokens: readonly string[],
  fields: ReadonlyArray<'category' | 'name' | 'district'>,
): boolean {
  if (tokens.length === 0) return false;
  for (const field of fields) {
    const value = place[field];
    if (typeof value !== 'string' || !value) continue;
    const haystack = normalize(value);
    if (tokens.some((t) => haystack.includes(t))) return true;
  }
  return false;
}

/**
 * 从预抓的 places 里筛出第 day 天可用的候选(§7 第 3 步)。
 * 依次剔除:非本城市 → 命中 excluded → 当天不营业。
 *
 * required_tags 不在这里做硬过滤 —— 饮食是软偏好,硬筛会把候选池砍空。
 */
export function filterCandidates<P extends Place>(
  places: readonly P[],
  constraints: Constraints,
  day: number,
  opts: FilterOptions = {},
): P[] {
  const fields = opts.matchExcludedAgainst ?? (['category', 'name'] as const);
  const tokens = (constraints?.excluded ?? []).map(normalize).filter(isUsableToken);
  const when = dayOf(constraints, day);

  return asArray(places).filter((place) => {
    if (!isFilled(place)) return false;
    if (place.city_key !== constraints.city_key) return false;
    if (matchesExcluded(place, tokens, fields)) return false;
    const ranges = rangesForDay(place, when);
    if (ranges !== null && ranges.length === 0) return false; // 当天休息
    return true;
  });
}

// ---------------------------------------------------------------------------
// 3. validateItinerary
// ---------------------------------------------------------------------------

interface CandidateIndex {
  ids: Set<string>;
  /** 只传 id 列表时为 null → 跳过营业时间检查 */
  places: Map<string, Place> | null;
}

function indexCandidates(
  candidates: readonly Place[] | Iterable<string> | null | undefined,
): CandidateIndex {
  const ids = new Set<string>();
  const places = new Map<string, Place>();
  let sawPlace = false;

  const iterable = candidates as Iterable<unknown> | null | undefined;
  if (iterable && typeof iterable[Symbol.iterator] === 'function') {
    for (const item of iterable) {
      if (typeof item === 'string') {
        if (item) ids.add(item);
      } else if (isObject(item) && typeof item['id'] === 'string' && item['id']) {
        sawPlace = true;
        ids.add(item['id']);
        places.set(item['id'], item as unknown as Place);
      }
    }
  }
  return { ids, places: sawPlace ? places : null };
}

function haystackOf(block: Block, place: Place | undefined): string {
  return normalize(
    [block.title, block.subtitle, place?.name].filter((v) => typeof v === 'string').join(' '),
  );
}

/**
 * 后置硬校验(§7 第 7 步)—— 整个防幻觉方案的核心。
 * 收集全部违规后返回,永不抛异常。
 *
 * candidates 传 Place[](filterCandidates 的输出)时六类检查全跑;
 * 只传 id 列表时营业时间那两条自动跳过,其余照跑。
 */
export function validateItinerary(
  blocks: readonly Block[],
  constraints: Constraints,
  candidates: readonly Place[] | Iterable<string>,
): ValidationResult {
  const violations: Violation[] = [];
  const list = asArray(blocks).filter((b) => isFilled(b));
  const { ids, places } = indexCandidates(candidates);
  const ceiling = finiteOr(constraints?.budget_ceiling, Number.POSITIVE_INFINITY);
  const days = finiteOr(constraints?.days, Number.POSITIVE_INFINITY);

  interface Timed {
    block: Block;
    start: number;
    end: number;
  }
  const byDay = new Map<number, Timed[]>();

  for (const block of list) {
    const label = block.title || block.id || '(未命名)';

    // --- day 落在行程范围内 ---
    if (!(Number.isInteger(block.day) && block.day >= 1 && block.day <= days)) {
      violations.push({
        code: 'invalid_day',
        message: `「${label}」的 day = ${String(block.day)},不在 1–${days} 范围内`,
        block_id: block.id,
        detail: { day: block.day, days },
      });
    }

    // --- place_id 必须来自候选(防 LLM 发明地点) ---
    if (typeof block.place_id !== 'string' || !block.place_id) {
      violations.push({
        code: 'missing_place',
        message: `「${label}」没有 place_id`,
        block_id: block.id,
        day: block.day,
      });
    } else if (!ids.has(block.place_id)) {
      violations.push({
        code: 'unknown_place',
        message: `「${label}」的 place_id ${block.place_id} 不在候选列表里`,
        block_id: block.id,
        day: block.day,
        detail: { place_id: block.place_id },
      });
    }

    // --- 时间可解析 ---
    const start = parseClock(block.start_time);
    const duration = block.duration_min;
    if (
      start === null ||
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      violations.push({
        code: 'invalid_time',
        message:
          `「${label}」的时间无法解析` +
          `(start_time = ${String(block.start_time)}, duration_min = ${String(duration)})`,
        block_id: block.id,
        day: block.day,
        detail: { start_time: block.start_time, duration_min: duration },
      });
      continue;
    }

    const timed: Timed = { block, start, end: start + duration };
    const bucket = byDay.get(block.day);
    if (bucket) bucket.push(timed);
    else byDay.set(block.day, [timed]);

    // --- 营业时间(只在拿到 Place 对象时才查) ---
    if (places && typeof block.place_id === 'string') {
      const place = places.get(block.place_id);
      if (place) {
        const when = dayOf(constraints, block.day);
        const ranges = rangesForDay(place, when);
        if (ranges !== null && ranges.length === 0) {
          violations.push({
            code: 'closed_that_day',
            message: `第 ${block.day} 天「${place.name}」全天不营业`,
            block_id: block.id,
            day: block.day,
            detail: { place_id: place.id, date: when?.iso },
          });
        } else if (!isOpenDuring(ranges, timed.start, timed.end)) {
          violations.push({
            code: 'outside_opening_hours',
            message:
              `「${label}」排在 ${formatClock(timed.start)}–${formatClock(timed.end)},` +
              `不在「${place.name}」的营业时间内`,
            block_id: block.id,
            day: block.day,
            detail: {
              place_id: place.id,
              block: `${formatClock(timed.start)}-${formatClock(timed.end)}`,
              hours: (ranges ?? []).map((r) => `${formatClock(r.start)}-${formatClock(r.end)}`),
            },
          });
        }
      }
    }
  }

  // --- 总花费 ≤ budget_ceiling ---
  const total = list.reduce((sum, b) => sum + finiteOr(b.cost_per_person, 0), 0);
  if (total > ceiling) {
    violations.push({
      code: 'over_budget',
      message: `人均总花费 ${total} 超出上限 ${ceiling}`,
      detail: { total, ceiling, over: total - ceiling },
    });
  }

  // --- 同一天时间不重叠(每天块数很少,直接两两比) ---
  for (const [day, items] of byDay) {
    const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (b.start >= a.end) break; // 已按 start 排序,后面的只会更晚
        violations.push({
          code: 'overlap',
          message:
            `第 ${day} 天「${a.block.title}」(${formatClock(a.start)}–${formatClock(a.end)})` +
            `与「${b.block.title}」(${formatClock(b.start)}–${formatClock(b.end)})时间重叠`,
          block_id: a.block.id,
          day,
          detail: { with_block_id: b.block.id },
        });
      }
    }
  }

  // --- forced 里的项目必须出现 ---
  const haystacks = list.map((b) =>
    haystackOf(b, places && typeof b.place_id === 'string' ? places.get(b.place_id) : undefined),
  );
  for (const item of constraints?.forced ?? []) {
    const token = normalize(item);
    if (!isUsableToken(token)) continue;
    if (!haystacks.some((h) => h.includes(token))) {
      violations.push({
        code: 'missing_forced',
        message: `must_do「${item}」没有出现在行程里`,
        detail: { item },
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 4. enforceBudget
// ---------------------------------------------------------------------------

function costOf(block: Block): number {
  return finiteOr(block.cost_per_person, 0);
}

/** 人均总花费 */
export function totalCost(blocks: readonly Block[]): number {
  return asArray(blocks).reduce((sum, b) => (isFilled(b) ? sum + costOf(b) : sum), 0);
}

/**
 * 超预算时按 cost 从高到低砍非 locked 的 block,直到达标(§7 第 7 步)。
 *
 * - locked 的永远不砍。全员 locked 仍超预算 → 原样返回,由 validateItinerary 报 over_budget
 * - 同价按 start_time 晚的先砍,再同则按原下标靠后的先砍(确定性,测试才稳)
 * - cost <= 0 的块砍了也不省钱,跳过
 * - 返回保持原始顺序
 */
export function enforceBudget<B extends Block>(
  blocks: readonly B[],
  constraints: Constraints,
  opts: EnforceBudgetOptions = {},
): B[] {
  const list = asArray(blocks).filter((b) => isFilled(b));
  const ceiling = finiteOr(constraints?.budget_ceiling, Number.POSITIVE_INFINITY);

  let total = list.reduce((sum, b) => sum + costOf(b), 0);
  if (total <= ceiling) return [...list];

  const forcedTokens = opts.protectForced
    ? (constraints?.forced ?? []).map(normalize).filter(isUsableToken)
    : [];
  const isForced = (block: B): boolean => {
    if (forcedTokens.length === 0) return false;
    const haystack = haystackOf(block, undefined);
    return forcedTokens.some((t) => haystack.includes(t));
  };

  const removable = list
    .map((block, index) => ({
      block,
      index,
      cost: costOf(block),
      forced: isForced(block),
      start: parseClock(block.start_time) ?? -1,
    }))
    .filter((x) => x.block.locked !== true && x.cost > 0)
    .sort(
      (a, b) =>
        Number(a.forced) - Number(b.forced) || // 受保护的排最后
        b.cost - a.cost || //                     贵的先砍
        b.start - a.start || //                   同价:晚的先砍
        b.index - a.index, //                     再同:靠后的先砍
    );

  const dropped = new Set<number>();
  for (const candidate of removable) {
    if (total <= ceiling) break;
    dropped.add(candidate.index);
    total -= candidate.cost;
  }

  return list.filter((_, index) => !dropped.has(index));
}
