# Apps review requirements

Use the reviewed repository's `AGENTS.md` and the procedures at that revision. These paths are relative to the Apps repository, not this skill's installation directory:

- Stateful changes: `.agents/skills/stateful-workflow-review/SKILL.md`.
- Authority, layer ownership, or durable handoff changes: `.agents/skills/architecture-boundary-review/SKILL.md`.
- Behavioral readiness: `.agents/skills/stateful-workflow-review/references/test-evidence.md`, including when no stateful review is otherwise needed.

Apply readiness gates when completing a behavioral implementation or giving a readiness verdict. A requested discovery pass remains a discovery pass and must state that readiness was not assessed. Stateful and architecture reviews still apply wherever the repository requires them; an effort cap does not waive those obligations.

The same independent reviewer can perform the applicable reviews. Reuse its source traces and decisive test evidence. Follow repository requirements for real persistence and production boundaries, producer coverage, observable or durable assertions, and failing-before/passing-after regression evidence. Do not count mock wiring or Storybook states as behavior proof. Report `Test evidence: PASS/BLOCKED` with the decisive scenario and boundary only after inspecting the evidence; missing or skipped required checks remain unfinished.

For bounded historical discovery, use relevant probes without claiming these gates passed. Do not load a newer procedure as evidence of an older revision's product contract.
