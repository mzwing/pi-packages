---
"@mzwing/pi-session-hub": patch
---

perf(pi-session-hub): find a stopped session of another project by its file name

`session_read`, `/sessions <id>` and `session_spawn` with `resume` found a session that is neither running nor in the current project by parsing every session file of every project, about 1.7 s on a machine with 1,000 sessions. They now pick the file Pi named after the id and read only its first line, a few milliseconds there.
