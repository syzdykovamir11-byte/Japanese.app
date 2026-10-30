---
name: design-loop
description: Use for any task that designs, redesigns, builds or polishes a website, landing page, web app screen or UI component. Builds the page, captures real screenshots at 4 widths, and runs an independent critic subagent until it passes a professional standard.
---

# Design loop

You are the designer and the engineer in one role. You design the page and write the code. A separate critic subagent audits the result from screenshots and measurements. It never sees your reasoning. That separation is the point of this workflow, so keep it intact.

`SKILL_DIR` below means the folder this SKILL.md is in. The critic's instructions are in `SKILL_DIR/critic.md`. The screenshot tool is `SKILL_DIR/scripts/shoot.mjs`.

All loop files live in `.design-loop/` at the project root (or in the working directory if there is no project).

```
.design-loop/
  brief.md
  spec.md
  plan-critique.md
  cycle-1/
    360/  01.png 02.png ... full.png reduced-motion-01.png
    768/  ...
    1024/ ...
    1440/ ... focus.png
    report.json
    qa.json
    critique.md
  cycle-2/  ... response.md
  cycle-3/  ...
```

## Scope

Use the full loop for pages and screens. For a single small component or a one-line style fix, do steps 3 and 4 only and skip the critic, unless the user asks for a review.

## Visual direction

The project's existing design system and the user's brand always win. Look for them first: tokens, tailwind config, globals.css, components/, brand assets, an existing site.

If there is no design system and no brand direction, use the user's default direction:
- Editorial restraint. Hierarchy from typography and whitespace, not from boxes, shadows and color.
- Hairline structure: 1px low-contrast borders instead of shadows.
- One accent color, for the primary action and active states only.
- Translucent chrome with backdrop-filter blur only for sticky navigation and overlays, never for content cards.
- Motion: transform and opacity only, ease-out (cubic-bezier(0.22, 1, 0.36, 1)), under 300ms, purposeful. Content must be visible without motion.
- Reference quality bar: Vercel, Linear, Bloomberg Graphics for data, Emil Kowalski for motion, Too Good To Go for warmth when the product needs it. These set the standard of craft, not a style to copy.
- Banned: glassmorphism cards, purple-blue gradients, gradient blobs, the generic SaaS hero (centered headline, gradient, two buttons, logo strip).

Write whichever direction applies into brief.md as constraints. The critic checks against them.

## Standards you design and build to

Typography
- Modular type scale, ratio 1.200–1.333. At most 2 typefaces. Choose them for the brand; Inter only with a reason.
- Body 16–18px. Line height 1.4–1.6 for body, 1.05–1.25 for display. Line length 45–75 characters.
- Fluid sizes with clamp(). Use `text-wrap: balance` on headings to avoid orphans.

Spacing and layout
- 4/8pt spacing scale. Every margin, padding and gap is a token.
- 12-column grid on desktop, 4 on mobile. One max content width.
- Breakpoints checked: 360, 768, 1024, 1440px.

Color
- A palette with roles: background, surface, text primary, text secondary, accent, border, states.
- Neutrals tinted toward the brand hue. The accent is for primary actions only.
- WCAG 2.2 AA: text 4.5:1, large text and UI components 3:1.

Hierarchy
- One primary action per screen.
- Order is set by size, weight, color and spacing before any decoration is added.

Code
- Semantic HTML: landmarks, one h1, logical heading order.
- All tokens as CSS custom properties. No magic numbers.
- Mobile-first CSS.
- Every interactive element has default, hover, focus-visible, active and disabled states.
- Targets at least 24×24px, 44×44px preferred on touch.
- Reveal animations start from a visible state under prefers-reduced-motion, and must not hide content if JavaScript fails.
- Alt text and form labels present.
- Explicit image width and height. Fonts loaded with font-display and no layout shift.
- No heavy libraries without a stated reason.

Avoid template defaults: Inter on white with a purple gradient, centered hero over blurred blobs, identical three-card feature grids, a decorative icon on every card, emoji as icons, "Get started" as the only CTA text, lorem ipsum.

## Hard limits

- Do not invent brand facts, client logos, testimonials or statistics. Use clearly marked placeholders such as `[Client quote — needs real text]`.
- Do not add decoration to cover weak hierarchy.
- Do not argue with a finding without evidence. Answer every finding as FIXED or DISPUTED.
- Do not pass your reasoning, intentions or self-assessment to the critic. It gets file paths only.
- Do not edit the critic's output or skip a cycle to reach APPROVED.
- When revising, change only what the findings require. Do not redesign parts that were not flagged.

## Steps

### 0. Setup

The screenshot tool needs Playwright, axe-core and Chromium. Install them once in `SKILL_DIR/scripts`, never in the user's project:

```
cd SKILL_DIR/scripts
node -e "require('playwright'); require('@axe-core/playwright')" 2>/dev/null || npm i
npx playwright install chromium
```

If Playwright is already installed globally (for example in a cloud sandbox), the script finds it through NODE_PATH and only `@axe-core/playwright` may need installing. If the shell or network is unavailable, tell the user the loop cannot capture screenshots in this environment, and stop rather than auditing from code.

Add `.design-loop/` to the project's `.gitignore` if the project uses git.

### 1. Brief

Write `.design-loop/brief.md` with: product, target audience, primary user action (the one conversion that matters), brand and aesthetic constraints, available content, stack, and your assumptions.

If facts are missing, write assumptions and continue. Ask the user only if the task is impossible without the answer, for example if you do not know what the product is.

If the user gave an existing site, link it in the brief, capture it into `cycle-0/` and run the critic in audit mode with `cycle: 0` before you change anything. Cycle 0 is a baseline and does not count toward the 3 cycles.

### 2. Plan

If the `frontend-design` skill is available, load it now. If the project has its own design system and the `design:design-system` skill is available, load it and conform to the system.

Write 2–3 distinct directions, one line each, in brief.md. Pick one and record the choice. If the choice depends on the user's taste and the user is present, ask.

Write `.design-loop/spec.md`:
- Page structure: sections in order, the purpose of each in one line.
- Tokens: color (hex, role, contrast ratio against its background), type scale, spacing scale, radius, border, shadow, motion.
- Grid and breakpoints.
- Component list.

The spec holds decisions only. No justifications, no "this creates a sense of". The critic reads it.

Run the critic in plan mode (see "Invoking the critic"). Save its output to `.design-loop/plan-critique.md`. Fix the spec for every finding, or note DISPUTED with evidence in the same file.

### 3. Build V1

If the `design:ux-copy` skill is available, load it before writing CTAs, labels, errors and empty states.

Build the page in the user's stack. If no stack is given, use a single static HTML file with inline CSS and minimal JS. The code must run as delivered.

### 4. Capture

Serve the page. A local dev server works. A static file can be passed as a path.

```
node SKILL_DIR/scripts/shoot.mjs <url-or-file> .design-loop/cycle-1
```

Add `--dark` if the page supports dark mode.

Then run the browser smoke test. It writes `qa.json` with console errors, failed requests, broken images and anchors, keyboard traversal, a click test of tabs, accordions and buttons, and lab performance (LCP, CLS, blocking time):

```
node SKILL_DIR/scripts/qa.mjs <url-or-file> .design-loop/cycle-1
```

Open the first tile at 360 and at 1440 yourself, plus any tile at a width where the console summary shows overflow or axe failures. Fix anything obviously broken and capture again before the audit. This is a sanity check, not a substitute for the critic.

### 5. Audit

Run the critic in audit mode with cycle 1. Save its output verbatim to `.design-loop/cycle-1/critique.md`.

### 6. Revise

If the status is REVISE:

1. Write `.design-loop/cycle-N+1/response.md`. One line per open finding ID: `FIXED — what changed` or `DISPUTED — evidence`.
2. Fix the code. Change only what the findings require.
3. Capture into `.design-loop/cycle-N+1/`.
4. Run the critic with the new cycle number, adding the previous critique and the new response to the paths.

Maximum 3 cycles.

### 7. Report to the user

Stop at APPROVED, or at BLOCKED after cycle 3. Tell the user:
- Status and the final score table.
- What changed between cycle 1 and the last cycle, in a few lines.
- The Unverified list from the critic.
- For BLOCKED: what input from the user would resolve each remaining finding.
- Where the final screenshots are (first tile at 360 and 1440). Show them if the interface can display images.

Do not soften or reframe the critic's verdict.

## Invoking the critic

The critic must run in a fresh context: a subagent that sees only the files.

- In Claude Code with the `design-critic` agent installed: invoke agent `design-critic`.
- Otherwise, with any subagent tool (Agent or Task): start a general-purpose subagent and begin its prompt with: "Read SKILL_DIR/critic.md and follow it exactly. You are read-only: do not create or edit any file. Return the critique as your final answer." Use the absolute path of SKILL_DIR.
- With no subagent tool at all: tell the user the critic cannot run independently here. Run it yourself as a separate step that reads critic.md and the files from disk, and mark the report "critic not independent".

Give the critic paths only, in this form:

```
mode: audit
cycle: N
Brief: <abs path>/.design-loop/brief.md
Spec: <abs path>/.design-loop/spec.md
Captures: <abs path>/.design-loop/cycle-N/  (read report.json and qa.json first, then every tile in 360/, 768/, 1024/, 1440/)
Source: <list of source files>
Previous critique: <path>   (cycle 2+)
Designer response: <path>   (cycle 2+)
```

For plan mode, pass only `mode: plan`, the brief and the spec.
