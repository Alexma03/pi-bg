# pi-bg Judgment Day result: APPROVED

- **Target.** `/home/alex/src/pi-bg` at `0b0073b`: the v1 code plus `docs/v1.1-proposal.md`.
- **Judges.** jd-judge-a (18 rows: 1 CRITICAL, 13 WARNING, 4 SUGGESTION) and jd-judge-b (11 rows: 4 CRITICAL, 7 WARNING).
- **Frozen severe IDs.** JD-A-001 (corroborated by JD-B-002), JD-B-001, JD-B-003 and JD-B-004. The canonical ledger hash for round 1 is fc6c9714….

| Round | Fix commit | Re-judgment |
| --- | --- | --- |
| 1 | `ea88411` | JD-A-001, JD-B-001 and JD-B-004 were verified by both judges. JD-B-003 was verified by A and corroborated by B; the controller reproduced the short final PEM line leaking when BEGIN is cut. |
| 2 | `49cfa1f` (JD-B-003 only, ledger 58e681c2…) | Verified by both judges. |

- **Final verification.** On `main` at `49cfa1f`: `pnpm test` 59/59 and typecheck clean.
- **WARNING / SUGGESTION rows.** These are informational under the protocol, but they are handled as ordinary work on the `feat/v1.1` branch (`/home/alex/src/pi-bg-v11`):
  - fixed with regression tests: A-002, A-003, A-004, A-005, A-006, A-007, A-008, A-010, A-011, A-013, A-014, A-015 (partly), A-016, A-018, B-005, B-006, B-007, B-008, B-009, B-010 and B-011;
  - design changes: A-012 (live state goes in wake messages instead of the system prompt) and A-017 (partly: polling stops when the bridge is off or fenced);
  - pending: A-009 (extension harness tests) and A-017's heartbeat-derived liveness.
