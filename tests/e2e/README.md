# End-to-end browser test

`run_e2e.sh` builds the website for production, starts the engine with the same command Railway uses,
puts them on different origins (like Netlify and Railway), and drives a real browser through four states:

| Phase | Engine state | What it proves |
|---|---|---|
| guest | Guest sign-in on | Sign-in, saving an API key, loading 24 starter grants, Kenedy record, writer handoff, urgent flag, writer page |
| expired | Restarted | A stale session returns to sign-in with an explanation and the token is cleared |
| locked | Guest sign-in off | No guest button, setup message shown, engine refuses guest sign-in (403) |
| down | Stopped | Clear "can't reach the engine" message naming the URL |

No Claude API key is needed: the AI steps aren't exercised.

```bash
cd ~/grantfinder && bash tests/e2e/run_e2e.sh
```

One-time setup is at the top of `run_e2e.sh`. Exit code 0 means every check passed.
Engine-side deadline and seed checks: `backend/tests/check_deadlines.py`.
