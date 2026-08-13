@echo off
REM Wrapper for Windows Task Scheduler. Keeps the scheduled action free of quoting
REM issues and guarantees the working directory is the repository root.
REM
REM The mkdir is required, not defensive: cmd evaluates the redirection below BEFORE
REM node starts, so on a tree where .autocommit does not exist yet the first
REM scheduled run would die with "system cannot find the path specified" and never
REM reach the script that would have created the directory.
cd /d "%~dp0.."
if not exist ".autocommit" mkdir ".autocommit"
node "scripts\auto-commit.mjs" >> ".autocommit\task.log" 2>&1
