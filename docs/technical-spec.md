# Detour — 技术方案

**Version** v1 · Sep 3, 2026
**配套文件** `docs/product-design-doc.md`(产品方向与功能)
**目标** 十天内做出一个能部署、能演示、演示不会挂的原型

---

## 0. 一句话

**Next.js + Supabase + Gemini,全部跑在 Vercel 上,不加第四个服务。**

十天、要能部署、demo 不能挂 —— 这三个约束下,**减少服务数量比选对框架更重要**。

---

## 1. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Next.js 15 App Router + TypeScript | 需要服务端藏 API key,Route Handlers 同 repo 就有 |
| 样式 / 组件 | Tailwind + **shadcn/ui** | 组件复制进 repo,直接改。Design 10% 评的是视觉一致性 |
| 部署 | Vercel | git push 即部署,每个 branch 有 preview URL,mentor 可直接点开 |
| 数据库 | Supabase(Postgres) | DB + Auth + Realtime + pgvector 一个服务全包 |
| 向量 | pgvector(Supabase 内建) | 零新增基建 |
| LLM | Gemini Flash | 有免费额度,支持 `responseSchema` 结构化输出 |
| Embedding | 与 LLM 同一家 | 少管一把 key |
| 校验 | **Zod** | LLM 输出必须过 schema,这是防幻觉的最后一道闸 |
| 天气 | **Open-Meteo** | 不需要 API key、不需要绑卡 |
| POI 事实 | Google Places(**预抓,不实时调**) | 见 §7 |
| 机酒 | Amadeus self-service | 测试环境免费,只用来证明「接得上」 |

### 明确不用

- ❌ **LangChain / LlamaIndex** — pgvector 检索就是五行 SQL,抽象层是纯负债
- ❌ **Pinecone / Weaviate / Chroma** — pgvector 已经在了
- ❌ **另起 Express / FastAPI** — 多一个服务就多一套部署、环境变量、CORS
- ❌ **Prisma** — migration 配置能吃掉一整天,直接写 SQL
- ❌ **Clerk / Auth0** — Supabase anonymous + magic link 够了
- ❌ **React Native / Flutter** — 题目允许 web-only
- ❌ **Docker** — Vercel 不需要

---

## 2. 前端框架:一个要先做的决定

> **队里有没有人用过 Next.js App Router?**
> 有 → 用 Next.js(本文默认)
> 没有 → 用 **Vite + React**

App Router 的 server component、`"use client"`、缓存机制有真实学习曲线,**没人熟的话可能烧掉一到两天**。评审不会因为你用了 App Router 加分。

两个方案只有三处不同,其余章节完全通用:

| | Next.js | Vite + React |
|---|---|---|
| 服务端代码位置 | `app/api/*/route.ts` | `api/*.ts`(Vercel 自动识别为 serverless function) |
| 路由 | 文件系统路由 | `react-router-dom` |
| 数据获取 | server component / fetch | `swr` 或 `@tanstack/react-query` |

**两边都是 React** —— 组件、hooks、JSX 一模一样。

---

## 3. 系统架构

```
                    Trip 输入(预算 / 日期 / 群体偏好)
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  ┌───────────┐         ┌───────────────┐       ┌───────────────┐
  │ L1 FACTS  │         │  L2 TASTE     │       │ L3 CONSTRAINTS│
  │ places 表 │         │  pgvector RAG │       │  规则引擎     │
  │ (预抓)    │         │  (Wikivoyage) │       │  (纯函数)     │
  └─────┬─────┘         └───────┬───────┘       └───────┬───────┘
        │ 候选地点 + 事实        │ 片段 + 出处            │ 硬约束
        └───────────────────────┼───────────────────────┘
                                ▼
                        ┌───────────────┐
                        │ L4 LLM 组装   │  只从候选里挑,不许发明地点
                        └───────┬───────┘
                                ▼
                        Zod 校验 → 后置硬校验 → 落库
                                ▼
                     行程块 + 可展开的「为什么是它」
```

**❌ RAG 绝不提供 hours / price。** 那是用户会当场翻脸的数据,幻觉成本最高。

---

## 4. 目录结构

```
/app
  /(app)/t/[slug]/page.tsx        Itinerary(主界面)
  /(app)/t/[slug]/join/page.tsx   Preference Intake(成员视角)
  /(app)/t/[slug]/profile/page.tsx Taste Profile
  /(app)/t/[slug]/budget/page.tsx Budget & Split
  /api/...                        见 §6
/components                       shadcn/ui + 业务组件
/lib
  constraints.ts    规则引擎(纯函数,可单测)
  generate.ts       生成流水线
  replan.ts         重排流水线
  rag.ts            检索
  schemas.ts        Zod schema(唯一的类型来源)
  supabase.ts       client
/scripts
  fetch-places.ts   一次性预抓 POI
  build-index.ts    一次性建 RAG 索引
/seeds
  osaka-trip.json   ← demo 兜底数据
  osaka-places.json
/supabase/migrations
/docs
```

`lib/constraints.ts` 是纯函数,**没有网络、没有 LLM**,所以可以直接跑单测。这是整个项目里唯一值得写测试的地方。

---

## 5. 数据库 Schema

```sql
create extension if not exists vector;

create table trips (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,              -- OSK-4K2,用在邀请链接里
  destination text not null,
  city_key text not null,                 -- 'osaka' — 决定用哪份 POI / RAG 语料
  start_date date not null,
  end_date date not null,
  budget_per_person int not null,
  captain_id uuid,
  created_at timestamptz default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips on delete cascade,
  display_name text not null,
  is_captain boolean default false
);

create table preferences (
  member_id uuid primary key references members on delete cascade,
  trip_id uuid references trips on delete cascade,
  budget_band text,        -- low | mid | high
  pace text,               -- chill | balanced | packed
  interests text[],
  dietary text[],
  must_do text,
  no_go text
);

-- L1 FACTS:预抓的 POI 缓存,demo 不依赖实时 API
create table places (
  id text primary key,                    -- google place_id
  city_key text not null,
  name text not null,
  category text,
  district text,
  lat double precision, lng double precision,
  opening_hours jsonb,
  est_cost_per_person int,
  avg_duration_min int,
  indoor boolean default false,
  veg_friendly boolean default false,
  fetched_at timestamptz default now()
);

create table blocks (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips on delete cascade,
  day int not null,
  start_time time not null,
  duration_min int not null,
  title text not null,
  subtitle text,
  place_id text references places,
  cost_per_person int default 0,
  locked boolean default false,           -- re-plan 绝不移动
  reason jsonb,                           -- { budget, votes, constraint }
  source_citation jsonb,                  -- { text, source, url }
  created_by text                         -- ai | captain | replan
);

create table votes (
  member_id uuid references members on delete cascade,
  block_id uuid references blocks on delete cascade,
  value smallint,                         -- +1 / -1
  primary key (member_id, block_id)
);

create table disruptions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips on delete cascade,
  day int not null,
  type text not null,                     -- delay | weather | closed | overbudget
  payload jsonb,
  created_at timestamptz default now()
);

-- 关键设计:diff 单独存,不直接改 blocks
create table replan_diffs (
  id uuid primary key default gen_random_uuid(),
  disruption_id uuid references disruptions on delete cascade,
  ops jsonb not null,                     -- [{op, block_id?, to?, block?, note}]
  budget_delta int,
  status text default 'pending',          -- pending | accepted | partial | rejected
  accepted_ops jsonb,
  created_at timestamptz default now()
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips on delete cascade,
  payer_id uuid references members,
  label text,
  amount int,
  split_among uuid[]
);

-- L2 TASTE:RAG 语料
create table local_knowledge (
  id bigserial primary key,
  city_key text not null,
  chunk text not null,
  source text not null,                   -- 'Wikivoyage / Osaka'
  url text,
  district text,
  tags text[],
  embedding vector(768)                   -- 维度跟着你选的 embedding 模型改
);
create index on local_knowledge using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

检索函数:

```sql
create or replace function match_knowledge(
  query_embedding vector(768), p_city text, match_count int
) returns table (chunk text, source text, url text, similarity float)
language sql stable as $$
  select chunk, source, url, 1 - (embedding <=> query_embedding)
  from local_knowledge
  where city_key = p_city
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

> **为什么 `replan_diffs` 要单独存表?**
> 这样 diff 才有历史、才能「只接受部分」、才能回滚。这是 re-plan 功能的核心设计决定,不是过度设计。

---

## 6. API 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/trips` | 建团 → 返回 `slug` |
| POST | `/api/trips/[slug]/join` | 成员加入(免注册) |
| POST | `/api/preferences` | 提交偏好问卷 |
| GET | `/api/trips/[slug]/profile` | Taste Profile — **纯规则计算,不调 LLM** |
| POST | `/api/trips/[slug]/generate` | 生成行程(§7) |
| POST | `/api/trips/[slug]/replan` | 产出 diff,**不改 blocks** |
| POST | `/api/replans/[diffId]/accept` | 按勾选的 ops 应用改动 |
| POST | `/api/blocks/[id]/lock` | 锁定 / 解锁 |
| POST | `/api/blocks/[id]/vote` | 投票 |
| GET | `/api/trips/[slug]/budget` | 预算与分账 |

**两个原则:**

1. `replan` 只算不改,`accept` 才改。前端可以反复看 diff 而不产生副作用。
2. Taste Profile **不调 LLM**。共识和冲突是纯集合运算,用 LLM 又慢又不稳。

---

## 7. 生成引擎(核心逻辑)

```
1. 载入 trip + 所有 preferences

2. 【L3 规则层】算出约束集
   budget_ceiling = min(所有人的预算上限)      ← 取最低那位,不是平均
   blocks_per_day = { chill: 3, balanced: 4, packed: 5 }[多数人的 pace]
   required_tags  = 所有人的 dietary 并集
   forced         = 所有人的 must_do
   excluded       = 所有人的 no_go 并集

3. 【L1 Facts】从 places 表拉候选(已预抓)
   按 city_key 过滤 → 按 excluded 剔除 → 按营业时间可行性剔除

4. 【L2 Taste】对每个 interest / must_do 生成 query
   → embed → match_knowledge(top 4) → 拿到片段 + 出处

5. 【L4 LLM】输入 = 候选地点列表 + 约束 + 知识片段
   输出 = 严格 JSON schema(responseSchema + Zod 双保险)

6. Zod 校验失败 → 重试一次 → 再失败 → 读 seeds/osaka-trip.json

7. 【后置硬校验】← 这一步最重要
   ✓ 每个 block 的 place_id 必须存在于第 3 步的候选列表   ← 防止 LLM 发明地点
   ✓ 总花费 ≤ budget_ceiling,超了就砍最贵的非锁定块
   ✓ 同一天时间不重叠,且都落在营业时间内
   ✓ forced 里的项目必须出现

8. 落库,reason 与 source_citation 一起写入
```

**第 7 步是整个方案的防幻觉核心:LLM 只能从给定候选里挑,不能自己造地点。** 这句话在 pitch 里要讲。

---

## 8. Re-plan 引擎

```
1. 输入 disruption { day, type, payload }

2. 取当天 blocks,切成两堆:
   [不可动] = locked 的 + 已经过去的
   [可动]   = 其余

3. 【规则层】算出新的可用时间窗
   delay      → 起点后移 N 小时
   weather    → 屏蔽所有 indoor = false 的候选
   closed     → 剔除指定 place_id
   overbudget → 目标:总额降到 ceiling 以下

4. 【Facts】拉替补候选(同 district 优先;下雨时 indoor 优先)

5. 【Taste】给替补拿理由与出处

6. 【LLM】只负责:在给定候选和时间窗内产出 ops 数组
   ops = [{ op: 'move'|'remove'|'add'|'keep', block_id?, to?, block?, note }]

7. Zod 校验 ops
   ✓ 硬性检查:没有任何 op 触碰 locked block   ← 违反就整个重来
   ✓ note 必填 —— 每条改动都必须有理由

8. 写入 replan_diffs (status = pending),返回前端。**blocks 不动。**

9. 用户勾选后 → /accept 按 accepted_ops 应用,重算预算
```

---

## 9. RAG 索引构建(离线,只跑一次)

```
scripts/build-index.ts
  1. 抓 Wikivoyage 大阪/京都/奈良条目(开放授权,可整包下载)
     补充:Reddit API 上 r/JapanTravel 的相关讨论、几篇博客
  2. 按段落切 chunk,每段 200–400 字,保留 source / url / district
  3. 批量 embed
  4. 写入 local_knowledge
  5. 把结果 dump 成 SQL,commit 进 repo
```

**规模:300–800 chunk,单城市。现场绝不跑爬虫。**
建索引大约 20 分钟,几百个 chunk 的 embedding 成本接近零。

---

## 10. 外部 API 策略

| API | 用法 | 注意 |
|---|---|---|
| Google Places | **一次性预抓** 大阪 ~30 个候选点写进 `places` 表 | 要绑卡、有配额。demo 当天不调它 |
| Open-Meteo | 实时调 | 不需要 key,不需要绑卡 |
| Amadeus | 实时调,但结果缓存 | 测试环境数据是假的,只用来证明「接得上」 |

> 预抓不是作弊 —— 生产环境本来就该缓存 POI 数据。
> **架构图上照样画「Places API → Facts 层」,评审看到的是真实数据,而 demo 不依赖任何实时配额。**

---

## 11. 容错设计(第一天就写,不是第九天)

每个 AI 端点都是这个结构:

```ts
export async function generateItinerary(input: Input): Promise<Itinerary> {
  try {
    const raw = await callLLM(buildPrompt(input));
    const parsed = ItinerarySchema.safeParse(raw);
    if (parsed.success) return postValidate(parsed.data, input);

    const retry = await callLLM(buildPrompt(input, { stricter: true }));
    const parsed2 = ItinerarySchema.safeParse(retry);
    if (parsed2.success) return postValidate(parsed2.data, input);
  } catch (e) {
    console.error('[generate] falling back to seed', e);
  }
  return SEED_ITINERARY;                 // seeds/osaka-trip.json
}
```

**这段代码 20 行,但它是 demo 不会挂的唯一保障。**
第九天再补来不及 —— 那时没时间测。

---

## 12. 环境变量

```
# .env.local（加进 .gitignore）
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # 只在 server 用
GEMINI_API_KEY=                 # 只在 server 用
GOOGLE_PLACES_API_KEY=          # 只在 scripts 用
AMADEUS_CLIENT_ID=
AMADEUS_CLIENT_SECRET=
```

**API key 绝对不能出现在客户端。** 全部走 Route Handler。
如果评审打开 devtools 看到你的 key,印象分会很难看。

---

## 13. 分工与分支

| 角色 | 负责 | 主要文件 |
|---|---|---|
| **Frontend** | 七张界面 · 组件 · 状态 · 响应式 | `app/(app)/**`, `components/**` |
| **Backend** | Route handlers · **规则引擎** · 生成与 re-plan 的编排 · diff 落库 | `app/api/**`, `lib/constraints.ts`, `lib/generate.ts`, `lib/replan.ts` |
| **Database** | Supabase schema / migration / RLS · **POI 预抓脚本** · **RAG 索引构建** · seed 数据 | `supabase/**`, `scripts/**`, `seeds/**` |
| **AI & API** | Prompt · Zod schema · 结构化输出与解析 · embedding 与检索 · 外部 API 接入 · 兜底逻辑 | `lib/schemas.ts`, `lib/rag.ts`, LLM / API client |

### Backend 与 AI 的边界

这两个角色最容易撞车,边界要划清楚:

- **AI & API 负责「进模型的和出模型的」** —— prompt、schema、解析、检索、外部 API
- **Backend 负责「系统拿它做什么」** —— 调用前的硬约束、调用后的硬校验、diff 落库、端点

接缝就是 `lib/schemas.ts`。**这个文件 Sep 5 定下来并冻结**,两人共同确认后再各自开工。

### Ideation 与 Pitch 由谁负责

四个技术角色都排满了,但 rubric 里 **Ideation 25% + Presentation 15% = 40%** 没有人认领 —— 这是这套分工最大的风险。

**指派给 Database。** 理由:schema + 预抓 + 建索引的重活在 Sep 6 之前就做完了,Sep 7–13 有完整时间做三张图、mentor 日志和 pitch deck。其他三个角色会一路忙到 Sep 12。

另外单独指定一位 **pitch 主讲** —— 标准是谁讲得好,不是谁写的代码多(Delivery & Confidence 占 4%)。

### 层状分工的最大风险:集成留到最后

按层分工的团队最典型的失败是「各自做完,最后两天发现接不上」。

**对策:Sep 7 之前先打通一条竖切。** 只做 `Itinerary` 这一张界面,但让它真的从 UI → route handler → Supabase → LLM → 回到 UI 走通一遍。这条竖切通了,剩下六张界面就只是重复劳动。

**不要四个人各自埋头做完自己那一层再合。**

### 分支策略

- `main` 永远可部署
- 每人一条 feature branch,开 PR 合
- Vercel 每个 PR 自动出 preview URL —— **给 mentor 看的就是这个链接**

---

## 14. 落地顺序

| 日期 | 做什么 |
|---|---|
| Sep 5 | 定 `lib/schemas.ts` + Supabase schema 上线 + Figma flow 画完 |
| Sep 6 | **骨架部署上 Vercel**(先确保能上线)+ 离线建 RAG 索引 + 预抓 places |
| Sep 7 | **竖切里程碑**:Itinerary 一张界面打通全部四层 |
| Sep 7–8 | 界面 1–4 · 生成引擎第一版 · Taste Profile(纯规则) |
| Sep 9–10 | **Re-plan + diff**(hero)· 投票锁定 · 容错兜底 |
| Sep 11 | Mentor 第二轮 + 当天把反馈改进去 |
| Sep 12 | 冻结代码 · 排练 · **录 demo 备份影片** |
| Sep 13 | 只跑 demo 脚本,不改任何东西 |

---

## 15. 风险清单

| 风险 | 处理 |
|---|---|
| LLM 返回结构不对 | Zod + 重试 + seed 兜底(§11) |
| LLM 发明不存在的地点 | 后置硬校验:place_id 必须在候选列表里(§7 步骤 7) |
| re-plan 动了锁定块 | Zod 之后的硬性检查,违反就整个重来(§8 步骤 7) |
| Google Places 配额 / 绑卡 | 预抓进 DB,demo 不实时调(§10) |
| Supabase 免费项目被暂停 | 长时间无活动会暂停。**评审前一天去戳一下确认它醒着** |
| API key 泄漏 | 全走 Route Handler,`.env.local` 进 `.gitignore` |
| 现场网络出事 | seed 兜底 + 录好的 demo 影片 |
| Vercel function 超时 | Hobby 现在是 300 秒,不是问题 |
| 层状分工各做各的,最后接不上 | Sep 7 竖切里程碑 + `lib/schemas.ts` 提前冻结(§13) |
| Ideation 与 pitch 无人认领 | 明确指派给 Database,并排进日程(§13) |

---

*免费额度政策经常变,注册时自己再确认一下当下的限制。*
