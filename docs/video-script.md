# Detour4U — Video Script (4:30)

**Hard limit 5:00 — marks lost above it. Target 4:30.**
Narration ≈ 640 words at a comfortable 145 wpm. Read it out loud once with a timer before recording.

**Title on YouTube: team name only. Visibility: Unlisted.**

---

## Timing map

| Time | Screen | Section |
| :---- | :---- | :---- |
| 0:00–0:20 | Slide 1 | Hook + problem |
| 0:20–0:40 | Slide 2 | Solution thesis |
| 0:40–1:05 | Desktop · Trip Setup | Flow starts |
| 1:05–1:30 | Phone · Preference Intake | Member's 60 seconds |
| 1:30–1:55 | Desktop · Taste Profile | Conflict appears |
| 1:55–2:25 | Desktop · Itinerary + Why this | The cockpit |
| 2:25–3:05 | Phone · Re-plan | **The hero moment** |
| 3:05–3:45 | Slide 3 · Architecture | Tech stack |
| 3:45–4:25 | Slide 4 · Close | Build plan + impact |

---

## Script

### 0:00 — Slide 1: the problem

> Every group trip has one person who plans it. They open five tabs, a spreadsheet and a group chat — and everyone else replies "up to you."
>
> Then the flight is delayed, and every plan they made quietly becomes wrong. Wanderlog, TripIt, Google Travel — all of them stop at the moment the plan is agreed. None of them help after it.

### 0:20 — Slide 2: the thesis

> We built Detour4U. Other apps give you an itinerary. **We give you an itinerary that repairs itself.**
>
> Let me show you the whole flow.

### 0:40 — Desktop · Trip Setup

*Screen: fill the form, press Create trip, invite link and QR appear.*

> The Captain sets up the trip — Osaka, five days, three thousand ringgit each. They get a link. That's the last thing they have to chase anyone about.

### 1:05 — Phone · Preference Intake

*Screen: switch to phone. Step through the questionnaire quickly. Land on "Done — 47 seconds."*

> This is what a member sees. One question per screen. No signup, no app to install. Budget, pace, interests, dietary needs, one must-do, one never-again.
>
> Forty-seven seconds. That's the entire ask. **Group input is required — group decision-making is not.**

### 1:30 — Desktop · Taste Profile

*Screen: back to desktop. The new conflict card animates in.*

> And the moment they finish, the Captain's screen changes. A new conflict just appeared — one member wants a packed pace, three want chill, and someone eats halal.
>
> We don't ask the group to vote on this. We hand the Captain the conflict, and a suggested resolution. **He decides. The group advises.**

### 1:55 — Desktop · Itinerary, open a block

*Screen: the two-column cockpit. Budget bar at the top. Click a block; the Why this panel fills the right column. Scroll to the citation.*

> Here's the plan. Budget is pinned at the top, because money is a constraint, not a total you discover later.
>
> And every block explains itself. Budget headroom. Who voted for it. Which constraint it satisfies. And a cited source — a real line from a real travel guide.
>
> That last one matters. The organiser's hidden pain isn't the work — it's being blamed for the restaurant nobody liked. Now the reason is on the screen, not on them.

### 2:25 — Phone · Re-plan  ← SLOW DOWN HERE

*Screen: phone. Tap Re-plan, choose "Flight delayed 3h", the diff appears. Untick one row. Press Accept. Return to the itinerary — blocks changed, budget bar moved.*

> Now the part nobody else does.
>
> The flight is delayed three hours. One tap.
>
> Osaka Castle is removed — you'd land after last entry. Dinner moves to eight-thirty; we checked it's open until eleven. A night market fills the gap. And the hotel check-in stays exactly where it is, because it's locked — **a locked block is never moved.**
>
> Every line has a reason, and I can untick any of them. A re-plan is a proposal, not something done to you.
>
> Accept — and the plan and the budget both update. Eighteen ringgit cheaper.

### 3:05 — Slide 3: architecture

*Slide: the four-layer diagram.*

> Under that: APIs give us facts — opening hours, prices. Retrieval over local travel writing gives us taste, and the citation. A deterministic rule engine owns the hard limits — budget, time, locks. The model only assembles.
>
> **Opening hours and prices never come from the model.** That's the data a user checks and catches you on. The model can't even name a place we haven't already verified.
>
> Next.js and Supabase on Vercel, Gemini with structured output, pgvector for retrieval. The rule engine and the re-plan engine are already written and unit-tested.

### 3:45 — Slide 4: close

*Slide: build plan + one line of impact.*

> In the build phase: live data, the group layer, then offline. Because the moment you most need a re-plan — delayed at a foreign airport with no roaming — is the moment you have the worst connection. Detour4U installs to your home screen and keeps working.
>
> One person spends fifteen hours planning a trip. Everyone else spends zero. We make that ninety minutes and sixty seconds — and when it all goes wrong, nobody has to start over.
>
> That's Detour4U. Thank you.

---

## Recording checklist

- [ ] Incognito window — no extensions, no bookmarks bar, no personal tabs
- [ ] Browser zoom 100%, window 1440px wide for desktop shots
- [ ] Phone shots: device toolbar at 390px, or a real phone screen-recorded
- [ ] Reset the demo before rolling so counts and budget start clean
- [ ] Mic test — one 20-second take, listen back, then record for real
- [ ] Record in segments and cut, not one continuous take
- [ ] **Time the final cut. Under 5:00. Aim 4:30.**
- [ ] Upload to YouTube · **Unlisted** · title = team name only
- [ ] Paste the link into README.md
