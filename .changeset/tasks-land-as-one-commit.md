---
"@mzwing/pi-task-governor": minor
---

feat(pi-task-governor): land each task as one commit with a message the coordinator writes

A task's work stays one commit without a message while it is worked, instead of one commit per developer run titled with the task id and carrying the developer's report. It merges with the message the coordinator gives `task_approve`, following the user's commit message skill or instructions, else the repository's convention or Conventional Commits.

A task whose rebase onto the bookmark conflicts keeps the rebase, conflict markers included, for its executor to resolve. Before, the merge commit left in its workspace kept the executor from developing or reviewing the task, and broke the sign-off requests of other tasks on the same bookmark.
