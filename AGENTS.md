# AGENTS.md

## 项目

Detour —— 会自己修复的团体旅行行程规划工具。Code4U Hackathon(Aug 31 – Sep 13)Lifestyle Track 参赛作品。

- 产品方向与功能:`docs/product-design-doc.md`
- 技术方案(架构 / schema / API / 核心逻辑):`docs/technical-spec.md`

技术栈:Next.js + TypeScript + Tailwind + shadcn/ui · Supabase(Postgres + pgvector)· Gemini · 部署在 Vercel。

文档约定:所有说明文档放在 `docs/`。根目录只保留 `README.md` 和本文件。

---

## 注意事项

每次改动完成后,都必须创建一个对应的 Git commit,以便后续追踪和回滚。

每次改动后,都必须编写或更新相关测试,并在交付给用户前,确保所有测试和验证全部通过。

---

## 测试范围

时间有限,测试集中在真正有回报的地方:

**必须写测试**

- `lib/constraints.ts` —— 规则引擎。纯函数,无网络无 LLM。重点覆盖:
  - 预算上限取所有人的最低值,不是平均值
  - 同一天行程时间不重叠,且都落在营业时间内
  - `must_do` 必须出现在结果里,`no_go` 必须被剔除
- `lib/replan.ts` 的 ops 校验 —— **任何 op 都不得触碰 `locked` 的 block**,这条必须有测试
- 生成结果的后置硬校验 —— 每个 block 的 `place_id` 必须存在于候选列表(防止 LLM 发明地点)
- Zod schema 的解析与兜底路径:结构不合法时会重试,再失败会返回 `seeds/osaka-trip.json`

**不写测试**

- React 组件与页面
- 真实 LLM 调用、外部 API 调用(用 mock 数据测调用方,不测第三方)

改动碰到上面「必须写测试」的文件时,同一个 commit 里要带上测试。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
