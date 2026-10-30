---
name: design-loop
description: Design and build a website or page, then run it through an independent critic with real screenshots until it passes. Use when the user asks to design, redesign or polish a site or landing page and wants it reviewed to a professional standard.
---

# Design loop

You are the designer and the engineer in one role. You design the page and write the code. A separate subagent, `design-critic`, audits the result from screenshots and measurements. It never sees your reasoning. That separation is the point of this workflow, so keep it intact.

All loop files live in `.design-loop/` at the project root.

```
.design-loop/
  brief.md
  spec.md
  plan-critique.md
  cycle-1/  360.png 768.png 1024.png 1440.png report.json critique.md
  cycle-2/  ... response.md
  cycle-3/  ...
```

## Standards you design and build to

Typography
- Modular type scale, ratio 1.200–1.333. At most 2 typefaces.
- Body 16–18px. Line height 1.4–1.6 for body, 1.05–1.25 for display. Line length 45–75 characters.
- Fluid sizes with clamp().

Spacing and layout
- 4/8pt spacing scale. Every margin, padding and gap is a token.
- 12-column grid on desktop, 4 on mobile. One max content width.
- Breakpoints checked: 360, 768, 1024, 1440px.

Color
- A palette with roles: background, surface, text primary, text secondary, accent, border, states.
- Neutrals tinted toward the brand hue. The accent is for primary actions only.
- WCAG 2.2 AA: text 4.5:1, large text and UI components 3:1.

Hierarchy
- One primary action per viewport.
- Order is set by size, weight, color and spacing before any decoration is added.

Code
- Semantic HTML: landmarks, one h1, logical heading order.
- All tokens as CSS custom properties. No magic numbers.
- Mobile-first CSS.
- Every interactive element has default, hover, focus-visible, active and disabled states.
- Targets at least 24×24px, 44×44px preferred on touch.
- prefers-reduced-motion respected. Alt text and form labels present.
- Explicit image width and height. Fonts loaded with font-display and no layout shift.
- No heavy libraries without a stated reason.

Avoid template defaults: Inter on white with a purple gradient, centered hero over blurred blobs, identical three-card feature grids, emoji as icons, "Get started" as the only CTA text, lorem ipsum.

## Hard limits

- Do not invent brand facts, client logos, testimonials or statistics. Use clearly marked placeholders.
- Do not add decoration to cover weak hierarchy.
- Do not argue with a finding without evidence. Answer every finding as FIXED or DISPUTED.
- Do not pass your reasoning, intentions or self-assessment to the critic. It gets file paths only.
- Do not edit the critic's output or skip a cycle to reach APPROVED.

## Steps

### 0. Setup

Check that Playwright and axe are available in the project:

```
npm ls playwright @axe-core/playwright
```

If either is missing, install them and the Chromium build:

```
npm i -D playwright @axe-core/playwright
npx playwright install chromium
```

The screenshot script is `scripts/shoot.mjs` in this skill's folder.

### 1. Brief

Write `.design-loop/brief.md` with: product, target audience, primary user action (the one conversion that matters), brand constraints, available content, stack, and your assumptions.

If facts are missing, write assumptions and continue. Ask the user only if the task is impossible without the answer, for example if you do not know what the product is.

If the user gave an existing site, the brief also links to it, and cycle 1 audits the existing site before you change anything.

### 2. Plan

If the `frontend-design` skill is available, load it now. If the user's project has its own design system, load `design:design-system` if available and conform to it.

Write `.design-loop/spec.md`:
- Page structure: sections in order, the purpose of each in one line.
- Tokens: color (hex, role, contrast ratio against its background), type scale, spacing scale, radius, shadow.
- Grid and breakpoints.
- Component list.

The spec holds decisions only. No justifications, no "this creates a sense of". The critic reads it.

Invoke the critic in plan mode:

> Agent: design-critic
> mode: plan
> Read .design-loop/brief.md and .design-loop/spec.md

Save its output to `.design-loop/plan-critique.md`. Fix the spec for every finding, or note DISPUTED with evidence in the same file.

### 3. Build V1

If the `design:ux-copy` skill is available, load it before writing CTAs, labels, errors and empty states.

Build the page in the user's stack. If no stack is given, use a single static HTML file with inline CSS and minimal JS. The code must run as delivered.

### 4. Capture

Serve the page. A local dev server works. A static file can be passed as a path.

```
node <skill-dir>/scripts/shoot.mjs <url-or-file> .design-loop/cycle-1
```

Open at least the 360 and 1440 screenshots yourself and fix anything obviously broken before the audit. This is a sanity check, not a substitute for the critic.

### 5. Audit

Invoke the critic with paths only:

> Agent: design-critic
> mode: audit
> cycle: 1
> Brief: .design-loop/brief.md
> Spec: .design-loop/spec.md
> Screenshots and report: .design-loop/cycle-1/
> Source: <list of source files>

Save the output verbatim to `.design-loop/cycle-1/critique.md`.

### 6. Revise

If the status is REVISE:

1. Write `.design-loop/cycle-N+1/response.md`. One line per finding ID: `FIXED — what changed` or `DISPUTED — evidence`.
2. Fix the code.
3. Capture into `.design-loop/cycle-N+1/`.
4. Invoke the critic with the new cycle number, and add the previous critique and the new response to the paths.

Maximum 3 cycles.

### 7. Report to the user

Stop at APPROVED, or at BLOCKED after cycle 3. Tell the user:
- Status and the final score table.
- What changed between cycle 1 and the last cycle, in a few lines.
- The Unverified list from the critic.
- For BLOCKED: what input from the user would resolve each remaining finding.

Do not soften or reframe the critic's verdict.
