# Public Announcement Checklist

The announcement happens when every box is checked. There is no date.

## Engine Stability (STAB-001)

- [ ] Phase 0 gate: lifecycle logging, agent health, deliverable contract
- [ ] Phase 1 gate: ghost tasks = 0 after process kill within 90s
- [ ] Phase 2 gate: task resumes from checkpoint after crash
- [ ] Phase 3 gate: tool timeout kills worker in ≤90s, agent process survives
- [ ] Phase 4 gate: classifier 18/20 correct, routing fallback emits SSE event
- [ ] Phase 5 gate: escalation delivered via secondary channel within 70s
- [ ] Phase 6 gate: all regression tests pass in CI, ghost tasks = 0 for 48h

## Product Readiness (LAUNCH-001)

- [ ] Phase A gate: 3 new users correctly identify completed work, failure cause, and required action
- [ ] Phase B gate: new developer completes setup and describes Plexo without reading docs
- [ ] Phase C gate: 5 developers answer "what does Plexo do?" from getplexo.com; 1 developer self-hosts in <20 min
- [ ] Phase D gate: 0 Critical findings, all High findings remediated, p95 API < 500ms under load
- [ ] Phase E gate: all workspace isolation tests pass, manual cross-workspace test confirms zero data bleed
- [ ] Phase F gate: Cohort 1 + Cohort 2 complete

## Beta Completion

- [ ] Cohort 1 (25 testers) complete, findings triaged, critical issues resolved
- [ ] Cohort 2 (75 testers) complete
- [ ] Majority of Cohort 2 answers Yes to "Did the agent do what you asked?"
- [ ] Majority of Cohort 2 answers Yes to "Did you understand what it produced?"
- [ ] Zero open Critical or High security findings
- [ ] Self-host guide validated by 10+ independent users

## Announcement Assets

- [ ] getplexo.com live (no beta language)
- [ ] GitHub v1.0.0 release published with changelog
- [ ] README accurate and all links work
- [ ] Announcement posted (HN, Twitter/X, relevant communities)
