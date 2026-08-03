# Demo hosting on HostGator

See `~/.claude/CLAUDE.md` for the full setup: on-the-fly demo sites publish via FTPS to a
dedicated, jailed FTP account on Stan's HostGator shared hosting, with credentials at
`~/.claude/secrets/demo-ftp.env`. This is global, not specific to this repo.

`https://demos.wanderingstan.com/` (the FTP root) serves a PHP index (`index.php`) that
auto-lists every subfolder as a link. Don't overwrite `index.php` when uploading a demo,
and don't manually maintain a demo list — any new `<slug>/` subfolder shows up on its own.
