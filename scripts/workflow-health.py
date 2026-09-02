#!/usr/bin/env python3
"""Fail-loud watchdog for scheduled GitHub Actions workflows.

The graphiti-core watcher failed on its daily cron for three days and nobody
noticed, because a red run in the Actions tab is silent. This job runs on its
own cron, reads every *other* scheduled workflow's recent runs through the
Actions API, and when one has failed N times in a row it opens (or updates) a
GitHub issue assigned to the maintainer -- which GitHub Mobile pushes as a
notification. When the workflow recovers, the issue is closed automatically.

The job itself always exits 0 on a clean check: the signal is the issue, not a
red run (a red watchdog would be as silent as the thing it watches). It exits
non-zero only when the watchdog itself cannot do its job, so a broken watchdog
is at least visible in the Actions tab.

Stdlib only -- no pip install, so it runs on any runner with python3.
"""

import glob
import json
import os
import re
import sys
import urllib.parse
import urllib.request

API = 'https://api.github.com'
CONSECUTIVE_FAILURES = 2
ASSIGNEE = 'dustin-olenslager'
ISSUE_LABEL = 'workflow-health'
# Conclusions that count as a failure. `cancelled`, `skipped` and `neutral`
# are inconclusive -- a cancelled run is a known runner flake here, not a
# failure -- so they are dropped from the sequence rather than breaking or
# extending a streak.
FAILURE_CONCLUSIONS = {'failure', 'timed_out', 'startup_failure'}
CONCLUSIVE = FAILURE_CONCLUSIONS | {'success'}

# This file itself carries a `schedule:` trigger; never watch the watchdog.
SELF_WORKFLOW = 'workflow-health.yml'


def _request(method, path, token, body=None):
    url = path if path.startswith('http') else API + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def scheduled_workflow_files():
    """Basenames of workflow files that declare a schedule+cron trigger."""
    found = []
    for path in sorted(glob.glob('.github/workflows/*.yml') +
                       glob.glob('.github/workflows/*.yaml')):
        base = os.path.basename(path)
        if base == SELF_WORKFLOW:
            continue
        with open(path, encoding='utf-8') as handle:
            text = handle.read()
        # A scheduled workflow has `schedule:` followed by a `- cron:` entry.
        if re.search(r'schedule:\s*(?:#[^\n]*)?\n\s*-\s*cron:', text):
            found.append(base)
    return found


def trailing_failures(runs):
    """Count consecutive failing runs from newest, skipping inconclusive ones.

    `runs` is the API's run list (newest first). Returns (streak, latest_run)
    where latest_run is the newest conclusive run, or None if there are none.
    """
    streak = 0
    latest = None
    counting = True
    for run in runs:
        conclusion = run.get('conclusion')
        if conclusion not in CONCLUSIVE:
            continue
        if latest is None:
            latest = run
        if not counting:
            continue
        if conclusion in FAILURE_CONCLUSIONS:
            streak += 1
        else:
            counting = False
    return streak, latest


def find_issue(repo, token, workflow_name):
    marker = issue_marker(workflow_name)
    query = 'repo:%s is:issue is:open label:%s in:title %s' % (
        repo, ISSUE_LABEL, workflow_name)
    result = _request('GET', '/search/issues?q=' + urllib.parse.quote(query),
                      token)
    for item in result.get('items', []):
        if marker in item.get('title', ''):
            return item
    return None


def issue_marker(workflow_name):
    return 'scheduled workflow "%s" is failing' % workflow_name


def open_or_update_issue(repo, token, workflow_name, streak, latest):
    existing = find_issue(repo, token, workflow_name)
    run_url = latest.get('html_url', '') if latest else ''
    title = 'workflow-health: %s' % issue_marker(workflow_name)
    body = (
        '@%s the scheduled workflow **%s** has failed **%d** runs in a row on '
        'the default branch.\n\n'
        'Latest run: %s\n\n'
        'This issue was opened automatically by `workflow-health`. It closes '
        'itself when the workflow next succeeds.'
    ) % (ASSIGNEE, workflow_name, streak, run_url)
    if existing is None:
        _request('POST', '/repos/%s/issues' % repo, token, {
            'title': title,
            'body': body,
            'labels': [ISSUE_LABEL],
            'assignees': [ASSIGNEE],
        })
        print('OPENED issue for %s (streak %d)' % (workflow_name, streak))
    else:
        _request('POST', '/repos/%s/issues/%d/comments' % (
            repo, existing['number']), token, {
            'body': 'Still failing: **%d** runs in a row. Latest: %s' % (
                streak, run_url),
        })
        print('UPDATED issue #%d for %s (streak %d)' % (
            existing['number'], workflow_name, streak))


def close_issue_if_open(repo, token, workflow_name, latest):
    existing = find_issue(repo, token, workflow_name)
    if existing is None:
        return
    run_url = latest.get('html_url', '') if latest else ''
    _request('POST', '/repos/%s/issues/%d/comments' % (
        repo, existing['number']), token, {
        'body': 'Recovered -- latest run is green: %s. Closing.' % run_url,
    })
    _request('PATCH', '/repos/%s/issues/%d' % (repo, existing['number']),
             token, {'state': 'closed'})
    print('CLOSED issue #%d for %s (recovered)' % (
        existing['number'], workflow_name))


def default_branch(repo, token):
    return _request('GET', '/repos/%s' % repo, token).get(
        'default_branch', 'main')


def workflow_id_by_file(repo, token):
    result = _request('GET', '/repos/%s/actions/workflows?per_page=100' % repo,
                      token)
    return {os.path.basename(w['path']): w['id']
            for w in result.get('workflows', [])}


def recent_scheduled_runs(repo, token, workflow_id, branch):
    path = ('/repos/%s/actions/workflows/%d/runs'
            '?event=schedule&status=completed&branch=%s&per_page=20') % (
        repo, workflow_id, branch)
    return _request('GET', path, token).get('workflow_runs', [])


def main():
    token = os.environ.get('GITHUB_TOKEN')
    repo = os.environ.get('GITHUB_REPOSITORY')
    if not token or not repo:
        print('GITHUB_TOKEN and GITHUB_REPOSITORY are required', file=sys.stderr)
        return 2
    dry_run = os.environ.get('DRY_RUN') == '1'

    files = scheduled_workflow_files()
    if not files:
        print('No scheduled workflows to watch.')
        return 0
    print('Watching scheduled workflows: %s' % ', '.join(files))

    branch = default_branch(repo, token)
    ids = workflow_id_by_file(repo, token)

    unhealthy = 0
    for base in files:
        workflow_id = ids.get(base)
        if workflow_id is None:
            print('SKIP %s -- not registered with Actions yet' % base)
            continue
        runs = recent_scheduled_runs(repo, token, workflow_id, branch)
        if not runs:
            print('SKIP %s -- no scheduled runs on %s yet' % (base, branch))
            continue
        streak, latest = trailing_failures(runs)
        name = runs[0].get('name', base)
        if streak >= CONSECUTIVE_FAILURES:
            unhealthy += 1
            print('UNHEALTHY %s -- %d consecutive failures' % (base, streak))
            if not dry_run:
                open_or_update_issue(repo, token, name, streak, latest)
        else:
            print('HEALTHY %s -- streak %d' % (base, streak))
            if not dry_run:
                close_issue_if_open(repo, token, name, latest)

    print('Done. Unhealthy: %d of %d.' % (unhealthy, len(files)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
