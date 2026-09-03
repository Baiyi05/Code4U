import { describe, expect, it } from 'vitest';

import {
  BAND_CEILING,
  buildConstraints,
  enforceBudget,
  filterCandidates,
  totalCost,
  validateItinerary,
  type Block,
  type Constraints,
  type Place,
  type Preference,
  type Trip,
  type ViolationCode,
} from './constraints';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 2026-09-07(周一)–09-09(周三),共 3 天 */
const TRIP: Trip = {
  id: 'trip-1',
  slug: 'OSK-4K2',
  destination: '大阪',
  city_key: 'osaka',
  start_date: '2026-09-07',
  end_date: '2026-09-09',
  budget_per_person: 1200,
};

let memberSeq = 0;
function makePref(over: Partial<Preference> = {}): Preference {
  memberSeq += 1;
  return {
    member_id: `m${memberSeq}`,
    trip_id: TRIP.id,
    budget_band: null,
    pace: null,
    interests: null,
    dietary: null,
    must_do: null,
    no_go: null,
    ...over,
  };
}

function makePlace(over: Partial<Place> = {}): Place {
  return {
    id: 'p1',
    city_key: 'osaka',
    name: '大阪城',
    category: 'sight',
    district: 'chuo',
    lat: null,
    lng: null,
    opening_hours: null,
    est_cost_per_person: 0,
    avg_duration_min: 60,
    indoor: false,
    veg_friendly: false,
    ...over,
  };
}

function makeBlock(over: Partial<Block> = {}): Block {
  return {
    id: 'b1',
    day: 1,
    start_time: '10:00',
    duration_min: 60,
    title: '大阪城',
    subtitle: null,
    place_id: 'p1',
    cost_per_person: 0,
    locked: false,
    ...over,
  };
}

/** 以 TRIP 为底,只覆盖关心的字段 */
function constraintsWith(over: Partial<Constraints> = {}): Constraints {
  return { ...buildConstraints(TRIP, []), ...over };
}

function codes(violations: { code: ViolationCode }[]): ViolationCode[] {
  return violations.map((v) => v.code);
}

function ids(blocks: readonly Block[]): string[] {
  return blocks.map((b) => b.id);
}

// ---------------------------------------------------------------------------
// 1. buildConstraints
// ---------------------------------------------------------------------------

describe('buildConstraints — budget_ceiling', () => {
  it('取所有人的最低值,不是平均值', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budget_band: 'low' }),
      makePref({ budget_band: 'mid' }),
      makePref({ budget_band: 'high' }),
    ]);

    expect(c.budget_ceiling).toBe(BAND_CEILING.low);

    // 显式钉死「不是平均值」这条 —— spec §7 特意点名的规则
    const average = (BAND_CEILING.low + BAND_CEILING.mid + BAND_CEILING.high) / 3;
    expect(c.budget_ceiling).not.toBe(average);
    expect(c.budget_ceiling).toBeLessThan(average);
  });

  it('成员顺序不影响结果', () => {
    const low = makePref({ budget_band: 'low' });
    const high = makePref({ budget_band: 'high' });
    expect(buildConstraints(TRIP, [low, high]).budget_ceiling).toBe(
      buildConstraints(TRIP, [high, low]).budget_ceiling,
    );
  });

  it('band 为空或非法的成员按 mid 算', () => {
    expect(buildConstraints(TRIP, [makePref({ budget_band: null })]).budget_ceiling).toBe(
      BAND_CEILING.mid,
    );
    expect(
      buildConstraints(TRIP, [makePref({ budget_band: 'luxury' as never })]).budget_ceiling,
    ).toBe(BAND_CEILING.mid);
    // 但仍然参与取最低
    expect(
      buildConstraints(TRIP, [makePref({ budget_band: null }), makePref({ budget_band: 'low' })])
        .budget_ceiling,
    ).toBe(BAND_CEILING.low);
  });

  it('一条 preference 都没有时回落到 trip.budget_per_person', () => {
    expect(buildConstraints(TRIP, []).budget_ceiling).toBe(TRIP.budget_per_person);
    expect(buildConstraints(TRIP).budget_ceiling).toBe(TRIP.budget_per_person);
  });

  it('band → 金额的映射可以覆盖', () => {
    const c = buildConstraints(TRIP, [makePref({ budget_band: 'low' })], {
      bandCeiling: { low: 300, mid: 600, high: 900 },
    });
    expect(c.budget_ceiling).toBe(300);
  });
});

describe('buildConstraints — blocks_per_day', () => {
  it('多数人的 pace 决定块数:chill 3 / balanced 4 / packed 5', () => {
    const chill = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'chill' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(chill.pace).toBe('chill');
    expect(chill.blocks_per_day).toBe(3);

    const balanced = buildConstraints(TRIP, [
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'chill' }),
    ]);
    expect(balanced.pace).toBe('balanced');
    expect(balanced.blocks_per_day).toBe(4);

    const packed = buildConstraints(TRIP, [
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'chill' }),
    ]);
    expect(packed.pace).toBe('packed');
    expect(packed.blocks_per_day).toBe(5);
  });

  it('平票一律回落 balanced:chill×1 packed×1', () => {
    const c = buildConstraints(TRIP, [makePref({ pace: 'chill' }), makePref({ pace: 'packed' })]);
    expect(c.pace).toBe('balanced');
    expect(c.blocks_per_day).toBe(4);
  });

  it('平票一律回落 balanced:balanced×2 packed×2', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
    expect(c.blocks_per_day).toBe(4);
  });

  it('平票双方都不是 balanced 时也回落 balanced:chill×2 packed×2', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'chill' }),
      makePref({ pace: 'packed' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
    expect(c.blocks_per_day).toBe(4);
  });

  it('三方平票也回落 balanced', () => {
    const c = buildConstraints(TRIP, [
      makePref({ pace: 'chill' }),
      makePref({ pace: 'balanced' }),
      makePref({ pace: 'packed' }),
    ]);
    expect(c.pace).toBe('balanced');
  });

  it('全员未填 pace → balanced', () => {
    expect(buildConstraints(TRIP, [makePref(), makePref()]).pace).toBe('balanced');
    expect(buildConstraints(TRIP, []).pace).toBe('balanced');
  });

  it('平票回落档位可以覆盖', () => {
    const c = buildConstraints(TRIP, [makePref({ pace: 'chill' }), makePref({ pace: 'packed' })], {
      defaultPace: 'chill',
    });
    expect(c.pace).toBe('chill');
    expect(c.blocks_per_day).toBe(3);
  });
});

describe('buildConstraints — 标签并集', () => {
  it('required_tags 是所有人 dietary 的并集,去空去重且大小写不敏感', () => {
    const c = buildConstraints(TRIP, [
      makePref({ dietary: ['halal', 'vegetarian'] }),
      makePref({ dietary: ['Halal', '  ', 'no pork'] }),
      makePref({ dietary: null }),
    ]);
    expect(c.required_tags).toEqual(['halal', 'vegetarian', 'no pork']);
  });

  it('forced 是所有人 must_do 的集合,按分隔符拆开', () => {
    const c = buildConstraints(TRIP, [
      makePref({ must_do: '环球影城、道顿堀' }),
      makePref({ must_do: 'teamLab, 环球影城' }),
      makePref({ must_do: '   ' }),
    ]);
    expect(c.forced).toEqual(['环球影城', '道顿堀', 'teamLab']);
  });

  it('excluded 是所有人 no_go 的并集', () => {
    const c = buildConstraints(TRIP, [
      makePref({ no_go: '夜店;赌场' }),
      makePref({ no_go: '夜店\n海鲜' }),
    ]);
    expect(c.excluded).toEqual(['夜店', '赌场', '海鲜']);
  });

  it('拆分器可以覆盖', () => {
    const c = buildConstraints(TRIP, [makePref({ no_go: 'a|b' })], {
      splitFreeText: (v) => v.split('|'),
    });
    expect(c.excluded).toEqual(['a', 'b']);
  });

  it('没人填时三组都是空数组', () => {
    const c = buildConstraints(TRIP, [makePref()]);
    expect(c.required_tags).toEqual([]);
    expect(c.forced).toEqual([]);
    expect(c.excluded).toEqual([]);
  });
});

describe('buildConstraints — 天数与透传', () => {
  it('days = end - start + 1', () => {
    expect(buildConstraints(TRIP, []).days).toBe(3);
  });

  it('同一天出发返回 → 1 天', () => {
    expect(
      buildConstraints({ ...TRIP, start_date: '2026-09-07', end_date: '2026-09-07' }, []).days,
    ).toBe(1);
  });

  it('跨月照样算对', () => {
    expect(
      buildConstraints({ ...TRIP, start_date: '2026-08-30', end_date: '2026-09-02' }, []).days,
    ).toBe(4);
  });

  it('日期非法时兜底为 1 天,不抛异常', () => {
    expect(buildConstraints({ ...TRIP, end_date: '2026-02-30' }, []).days).toBe(1);
    expect(buildConstraints({ ...TRIP, start_date: 'tomorrow' }, []).days).toBe(1);
  });

  it('city_key 与 start_date 原样带出', () => {
    const c = buildConstraints(TRIP, []);
    expect(c.city_key).toBe('osaka');
    expect(c.start_date).toBe('2026-09-07');
  });
});

// ---------------------------------------------------------------------------
// 2. filterCandidates
// ---------------------------------------------------------------------------

describe('filterCandidates', () => {
  it('剔除命中 excluded 的类别', () => {
    const c = constraintsWith({ excluded: ['夜店'] });
    const places = [
      makePlace({ id: 'keep', category: 'sight' }),
      makePlace({ id: 'drop', category: '夜店' }),
    ];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('excluded 也比对名称', () => {
    const c = constraintsWith({ excluded: ['海鲜'] });
    const places = [
      makePlace({ id: 'keep', name: '大阪城' }),
      makePlace({ id: 'drop', name: '黑门海鲜市场' }),
    ];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('默认不比对 district,加进 matchExcludedAgainst 才剔', () => {
    const c = constraintsWith({ excluded: ['namba'] });
    const places = [makePlace({ id: 'x', district: 'namba' })];

    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['x']);
    expect(
      filterCandidates(places, c, 1, { matchExcludedAgainst: ['category', 'name', 'district'] }),
    ).toEqual([]);
  });

  it('单个 ASCII 字符的 no_go 不会误伤(写个 b 不该剔掉所有 bar)', () => {
    const c = constraintsWith({ excluded: ['b'] });
    const places = [makePlace({ id: 'bar', category: 'bar' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['bar']);
  });

  it('单个 CJK 字的 no_go 仍然生效', () => {
    const c = constraintsWith({ excluded: ['酒'] });
    const places = [makePlace({ id: 'drop', category: '居酒屋' }), makePlace({ id: 'keep' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['keep']);
  });

  it('剔除别的城市', () => {
    const c = constraintsWith();
    const places = [makePlace({ id: 'osk' }), makePlace({ id: 'kul', city_key: 'kualalumpur' })];
    expect(filterCandidates(places, c, 1).map((p) => p.id)).toEqual(['osk']);
  });

  it('剔除当天不营业的:periods 里没写这个 weekday', () => {
    const c = constraintsWith();
    // day 1 = 2026-09-07 是周一(weekday 1),这家只写了周二
    const closedOnMonday = makePlace({
      id: 'tue-only',
      opening_hours: { periods: { 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(filterCandidates([closedOnMonday], c, 1)).toEqual([]);
    expect(filterCandidates([closedOnMonday], c, 2).map((p) => p.id)).toEqual(['tue-only']);
  });

  it('剔除当天不营业的:该 weekday 是空数组', () => {
    const c = constraintsWith();
    const place = makePlace({
      id: 'x',
      opening_hours: { periods: { 1: [], 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(filterCandidates([place], c, 1)).toEqual([]);
    expect(filterCandidates([place], c, 2).map((p) => p.id)).toEqual(['x']);
  });

  it('exceptions 覆盖 periods(公休日)', () => {
    const c = constraintsWith();
    const place = makePlace({
      id: 'x',
      opening_hours: {
        periods: { 1: [{ open: '09:00', close: '18:00' }] },
        exceptions: { '2026-09-07': [] },
      },
    });
    expect(filterCandidates([place], c, 1)).toEqual([]);
  });

  it('opening_hours 缺失时保留(容错:宁可留下,也不能把候选池洗空)', () => {
    const c = constraintsWith();
    const unknown = makePlace({ id: 'unknown', opening_hours: null });
    const garbage = makePlace({
      id: 'garbage',
      opening_hours: { periods: { 1: [{ open: '???', close: '???' }] } },
    });
    expect(filterCandidates([unknown, garbage], c, 1).map((p) => p.id)).toEqual([
      'unknown',
      'garbage',
    ]);
  });

  it('always_open 一律保留', () => {
    const c = constraintsWith();
    const place = makePlace({ id: 'x', opening_hours: { always_open: true, periods: { 2: [] } } });
    expect(filterCandidates([place], c, 1).map((p) => p.id)).toEqual(['x']);
  });

  it('泛型不丢调用方自己的字段', () => {
    const c = constraintsWith();
    const enriched = { ...makePlace(), similarity: 0.87 };
    const [first] = filterCandidates([enriched], c, 1);
    expect(first?.similarity).toBe(0.87);
  });

  it('入参不是数组时返回空数组,不抛异常', () => {
    const c = constraintsWith();
    expect(filterCandidates(null as unknown as Place[], c, 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. validateItinerary
// ---------------------------------------------------------------------------

describe('validateItinerary — place_id 必须来自候选(防幻觉)', () => {
  it('干净的行程没有任何违规', () => {
    const c = constraintsWith({ budget_ceiling: 500 });
    const places = [makePlace({ id: 'p1' })];
    const blocks = [makeBlock({ place_id: 'p1', cost_per_person: 100 })];
    expect(validateItinerary(blocks, c, places)).toEqual({ ok: true, violations: [] });
  });

  it('LLM 发明的地点 → unknown_place', () => {
    const c = constraintsWith();
    const result = validateItinerary([makeBlock({ place_id: 'hallucinated' })], c, ['p1']);
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toEqual(['unknown_place']);
    expect(result.violations[0]?.detail).toMatchObject({ place_id: 'hallucinated' });
  });

  it('没有 place_id → missing_place', () => {
    const c = constraintsWith();
    const result = validateItinerary([makeBlock({ place_id: null })], c, ['p1']);
    expect(codes(result.violations)).toEqual(['missing_place']);
  });
});

describe('validateItinerary — 预算', () => {
  it('总花费刚好等于上限时通过', () => {
    const c = constraintsWith({ budget_ceiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 200 }),
      makeBlock({ id: 'b', start_time: '14:00', cost_per_person: 100 }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('超出上限 1 块钱就报 over_budget', () => {
    const c = constraintsWith({ budget_ceiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 200 }),
      makeBlock({ id: 'b', start_time: '14:00', cost_per_person: 101 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['over_budget']);
    expect(result.violations[0]?.detail).toMatchObject({ total: 301, ceiling: 300, over: 1 });
  });

  it('跨天累计,不是按天算', () => {
    const c = constraintsWith({ budget_ceiling: 150 });
    const blocks = [
      makeBlock({ id: 'a', day: 1, cost_per_person: 100 }),
      makeBlock({ id: 'b', day: 2, cost_per_person: 100 }),
    ];
    expect(codes(validateItinerary(blocks, c, ['p1']).violations)).toContain('over_budget');
  });
});

describe('validateItinerary — 同一天时间不重叠', () => {
  it('重叠会被抓出来', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', start_time: '10:00', duration_min: 120 }),
      makeBlock({ id: 'b', start_time: '11:00', duration_min: 60 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['overlap']);
    expect(result.violations[0]).toMatchObject({ day: 1, detail: { with_block_id: 'b' } });
  });

  it('首尾相接不算重叠', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', start_time: '10:00', duration_min: 60 }),
      makeBlock({ id: 'b', start_time: '11:00', duration_min: 60 }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('不同天的同一时段不算重叠', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'a', day: 1, start_time: '10:00' }),
      makeBlock({ id: 'b', day: 2, start_time: '10:00' }),
    ];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('一个大块套住两个小块时,两对都报出来', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'big', start_time: '09:00', duration_min: 300 }),
      makeBlock({ id: 's1', start_time: '10:00', duration_min: 30 }),
      makeBlock({ id: 's2', start_time: '12:00', duration_min: 30 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['overlap', 'overlap']);
  });
});

describe('validateItinerary — 营业时间', () => {
  const openMonday9to18 = makePlace({
    id: 'p1',
    name: '大阪城',
    opening_hours: { periods: { 1: [{ open: '09:00', close: '18:00' }] } },
  });

  it('整段落在营业时间内 → 通过', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '10:00', duration_min: 120 })];
    expect(validateItinerary(blocks, c, [openMonday9to18]).ok).toBe(true);
  });

  it('结束时间越界 → outside_opening_hours', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '17:00', duration_min: 120 })];
    const result = validateItinerary(blocks, c, [openMonday9to18]);
    expect(codes(result.violations)).toEqual(['outside_opening_hours']);
    expect(result.violations[0]?.detail).toMatchObject({ block: '17:00-19:00' });
  });

  it('开门前 → outside_opening_hours', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '08:00', duration_min: 30 })];
    expect(codes(validateItinerary(blocks, c, [openMonday9to18]).violations)).toEqual([
      'outside_opening_hours',
    ]);
  });

  it('当天全天不营业 → closed_that_day', () => {
    const c = constraintsWith();
    // 只开周二,行程第 1 天是周一
    const tuesdayOnly = makePlace({
      id: 'p1',
      opening_hours: { periods: { 2: [{ open: '09:00', close: '18:00' }] } },
    });
    expect(codes(validateItinerary([makeBlock()], c, [tuesdayOnly]).violations)).toEqual([
      'closed_that_day',
    ]);
  });

  it('跨夜营业:18:00–02:00 的店,23:00 开始的块算合法', () => {
    const c = constraintsWith();
    const bar = makePlace({
      id: 'p1',
      opening_hours: { periods: { 1: [{ open: '18:00', close: '02:00' }] } },
    });
    expect(validateItinerary([makeBlock({ start_time: '23:00', duration_min: 90 })], c, [bar]).ok)
      .toBe(true);
    // 凌晨 00:30 的块也应归到这段跨夜营业里
    expect(validateItinerary([makeBlock({ start_time: '00:30', duration_min: 60 })], c, [bar]).ok)
      .toBe(true);
    expect(
      codes(
        validateItinerary([makeBlock({ start_time: '03:00', duration_min: 60 })], c, [bar])
          .violations,
      ),
    ).toEqual(['outside_opening_hours']);
  });

  it('opening_hours 缺失时不报违规', () => {
    const c = constraintsWith();
    const unknown = makePlace({ id: 'p1', opening_hours: null });
    expect(validateItinerary([makeBlock({ start_time: '03:00' })], c, [unknown]).ok).toBe(true);
  });

  it('只传 id 列表时跳过营业时间检查,其余照跑', () => {
    const c = constraintsWith();
    const blocks = [makeBlock({ start_time: '23:00', duration_min: 60 })];

    // 传 Place[] 会报违规
    expect(codes(validateItinerary(blocks, c, [openMonday9to18]).violations)).toEqual([
      'outside_opening_hours',
    ]);
    // 只传 id 就查不了营业时间,但 place_id 检查仍然生效
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
    expect(codes(validateItinerary(blocks, c, ['other']).violations)).toEqual(['unknown_place']);
  });

  it('Set 形式的 id 集合也认', () => {
    const c = constraintsWith();
    expect(validateItinerary([makeBlock()], c, new Set(['p1'])).ok).toBe(true);
  });
});

describe('validateItinerary — forced 必须出现', () => {
  it('命中 block 标题', () => {
    const c = constraintsWith({ forced: ['环球影城'] });
    const blocks = [makeBlock({ title: '环球影城 一日游' })];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('命中 subtitle', () => {
    const c = constraintsWith({ forced: ['teamLab'] });
    const blocks = [makeBlock({ title: '数字艺术', subtitle: '在 teamLab 泡两小时' })];
    expect(validateItinerary(blocks, c, ['p1']).ok).toBe(true);
  });

  it('命中候选地点的名称(传 Place[] 时)', () => {
    const c = constraintsWith({ forced: ['道顿堀'] });
    const place = makePlace({ id: 'p1', name: '道顿堀' });
    expect(validateItinerary([makeBlock({ title: '晚餐' })], c, [place]).ok).toBe(true);
  });

  it('大小写不敏感', () => {
    const c = constraintsWith({ forced: ['TeamLab'] });
    expect(validateItinerary([makeBlock({ title: 'teamlab botanical' })], c, ['p1']).ok).toBe(true);
  });

  it('缺失 → missing_forced,每条各报一次', () => {
    const c = constraintsWith({ forced: ['环球影城', '道顿堀'] });
    const result = validateItinerary([makeBlock({ title: '大阪城' })], c, ['p1']);
    expect(codes(result.violations)).toEqual(['missing_forced', 'missing_forced']);
    expect(result.violations.map((v) => v.detail?.['item'])).toEqual(['环球影城', '道顿堀']);
  });

  it('行程为空时 forced 全部报缺失', () => {
    const c = constraintsWith({ forced: ['环球影城'] });
    expect(codes(validateItinerary([], c, ['p1']).violations)).toEqual(['missing_forced']);
  });
});

describe('validateItinerary — 坏数据兜底', () => {
  it('day 超出行程范围 → invalid_day', () => {
    const c = constraintsWith(); // days = 3
    expect(codes(validateItinerary([makeBlock({ day: 4 })], c, ['p1']).violations)).toEqual([
      'invalid_day',
    ]);
    expect(codes(validateItinerary([makeBlock({ day: 0 })], c, ['p1']).violations)).toEqual([
      'invalid_day',
    ]);
  });

  it('时间解析不了 → invalid_time,且不影响其他 block', () => {
    const c = constraintsWith();
    const blocks = [
      makeBlock({ id: 'bad', start_time: '稍后' }),
      makeBlock({ id: 'ok', start_time: '14:00' }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(codes(result.violations)).toEqual(['invalid_time']);
    expect(result.violations[0]?.block_id).toBe('bad');
  });

  it('duration 为负 → invalid_time', () => {
    const c = constraintsWith();
    expect(codes(validateItinerary([makeBlock({ duration_min: -30 })], c, ['p1']).violations))
      .toEqual(['invalid_time']);
  });

  it('多条违规一次全返回,不短路', () => {
    const c = constraintsWith({ budget_ceiling: 100, forced: ['环球影城'] });
    const blocks = [
      makeBlock({ id: 'a', start_time: '10:00', duration_min: 120, cost_per_person: 200 }),
      makeBlock({ id: 'b', start_time: '11:00', place_id: 'ghost', cost_per_person: 50 }),
    ];
    const result = validateItinerary(blocks, c, ['p1']);
    expect(result.ok).toBe(false);
    expect(new Set(codes(result.violations))).toEqual(
      new Set(['unknown_place', 'over_budget', 'overlap', 'missing_forced']),
    );
  });

  it('入参完全是垃圾也不抛异常', () => {
    const c = constraintsWith();
    expect(() =>
      validateItinerary(
        [null, undefined, { id: 'x' }] as unknown as Block[],
        c,
        null as unknown as string[],
      ),
    ).not.toThrow();
    expect(() => validateItinerary(null as unknown as Block[], c, ['p1'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. enforceBudget
// ---------------------------------------------------------------------------

describe('enforceBudget', () => {
  it('已经达标时原样返回', () => {
    const c = constraintsWith({ budget_ceiling: 300 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 100 }),
      makeBlock({ id: 'b', cost_per_person: 100 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['a', 'b']);
  });

  it('按 cost 从高到低砍,砍到达标就停', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 50 }),
      makeBlock({ id: 'b', cost_per_person: 60 }),
      makeBlock({ id: 'c', cost_per_person: 30 }),
    ];
    const kept = enforceBudget(blocks, c);
    expect(ids(kept)).toEqual(['a', 'c']); // 砍掉最贵的 b,剩 80 ≤ 100,且保持原顺序
    expect(totalCost(kept)).toBeLessThanOrEqual(100);
  });

  it('砍到刚好等于上限就停手,不多砍一个', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 60 }),
      makeBlock({ id: 'b', cost_per_person: 55 }),
      makeBlock({ id: 'c', cost_per_person: 45 }),
    ];
    const kept = enforceBudget(blocks, c); // 160 - 60 = 100,正好卡线
    expect(ids(kept)).toEqual(['b', 'c']);
    expect(totalCost(kept)).toBe(100);
  });

  it('locked 的永远不砍 —— 全员 locked 时一个都不动', () => {
    const c = constraintsWith({ budget_ceiling: 10 });
    const blocks = [
      makeBlock({ id: 'a', cost_per_person: 500, locked: true }),
      makeBlock({ id: 'b', cost_per_person: 400, locked: true }),
    ];
    const kept = enforceBudget(blocks, c);
    expect(ids(kept)).toEqual(['a', 'b']);
    // 砍不动就是砍不动,超预算由 validateItinerary 报出来
    expect(codes(validateItinerary(kept, c, ['p1']).violations)).toContain('over_budget');
  });

  it('最贵的那个是 locked 时,改砍次贵的非 locked', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'locked', cost_per_person: 70, locked: true }),
      makeBlock({ id: 'b', cost_per_person: 60 }),
      makeBlock({ id: 'c', cost_per_person: 30 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['locked', 'c']);
  });

  it('同价时砍 start_time 晚的,且结果确定', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [
      makeBlock({ id: 'morning', start_time: '09:00', cost_per_person: 60 }),
      makeBlock({ id: 'evening', start_time: '19:00', cost_per_person: 60 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['morning']);
    expect(ids(enforceBudget(blocks, c))).toEqual(ids(enforceBudget(blocks, c)));
  });

  it('cost 为 0 的块砍了也不省钱,不动它', () => {
    const c = constraintsWith({ budget_ceiling: 50 });
    const blocks = [
      makeBlock({ id: 'locked', cost_per_person: 100, locked: true }),
      makeBlock({ id: 'free', cost_per_person: 0 }),
    ];
    expect(ids(enforceBudget(blocks, c))).toEqual(['locked', 'free']);
  });

  it('protectForced 打开时,must_do 的块最后才砍', () => {
    const c = constraintsWith({ budget_ceiling: 100, forced: ['环球影城'] });
    const blocks = [
      makeBlock({ id: 'usj', title: '环球影城', cost_per_person: 90 }),
      makeBlock({ id: 'aq', title: '海游馆', start_time: '15:00', cost_per_person: 80 }),
    ];
    // 默认照 §7 字面:只看 cost,先砍最贵的 usj
    expect(ids(enforceBudget(blocks, c))).toEqual(['aq']);
    // 打开保护后改砍 aq,must_do 留下
    expect(ids(enforceBudget(blocks, c, { protectForced: true }))).toEqual(['usj']);
  });

  it('返回的是新数组,不改动入参', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [makeBlock({ id: 'a', cost_per_person: 200 })];
    const kept = enforceBudget(blocks, c);
    expect(kept).not.toBe(blocks);
    expect(blocks).toHaveLength(1);
    expect(kept).toEqual([]);
  });

  it('泛型不丢调用方自己的字段', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    const blocks = [{ ...makeBlock({ id: 'a', cost_per_person: 50 }), reason: { budget: 'ok' } }];
    const [first] = enforceBudget(blocks, c);
    expect(first?.reason).toEqual({ budget: 'ok' });
  });

  it('入参是垃圾时不抛异常', () => {
    const c = constraintsWith({ budget_ceiling: 100 });
    expect(() => enforceBudget(null as unknown as Block[], c)).not.toThrow();
    expect(enforceBudget([null, undefined] as unknown as Block[], c)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 串起来:§7 第 7 步的完整后置校验
// ---------------------------------------------------------------------------

describe('enforceBudget → validateItinerary 串联', () => {
  it('砍完预算后 over_budget 就不再出现', () => {
    const c = buildConstraints(TRIP, [
      makePref({ budget_band: 'low' }), // ceiling = 800
      makePref({ budget_band: 'high' }),
    ]);
    const places = [makePlace({ id: 'p1', opening_hours: null })];
    const blocks = [
      makeBlock({ id: 'a', day: 1, start_time: '09:00', cost_per_person: 500 }),
      makeBlock({ id: 'b', day: 1, start_time: '13:00', cost_per_person: 400 }),
      makeBlock({ id: 'c', day: 2, start_time: '09:00', cost_per_person: 300 }),
    ];

    expect(c.budget_ceiling).toBe(800);
    expect(codes(validateItinerary(blocks, c, places).violations)).toContain('over_budget');

    const trimmed = enforceBudget(blocks, c);
    expect(totalCost(trimmed)).toBeLessThanOrEqual(c.budget_ceiling);
    expect(validateItinerary(trimmed, c, places)).toEqual({ ok: true, violations: [] });
  });
});
