# Cohort 1 Brief — Technical Self-Hosters

**Size**: 25 testers
**Engagement window**: 2 weeks from invite
**Feedback deliverable**: Completed structured feedback form (see `feedback-form.md`)

## Selection Criteria

- Self-hosts other open-source tools (n8n, Gitea, Coolify, Immich, similar)
- Comfortable with Docker Compose and reading container logs
- Has a spare VPS or home server with 2+ GB RAM available
- Has expressed interest in agent infrastructure, AI-assisted development, or autonomous task execution
- Can commit to running 5+ tasks over 2 weeks and filling out a structured form

## Testing Brief

### 1. Self-host from scratch

Follow `docs/self-host.md` to get a running Plexo instance. Time yourself from `git clone` to first successful task.

Report:
- Total setup time
- Every step where you got stuck, confused, or had to improvise
- Any missing prerequisites or unclear environment variable documentation
- Whether the onboarding wizard completed successfully

### 2. Run at least 5 tasks across at least 2 categories

Pick from:
- **Code**: bug fix, feature scaffold, test generation, refactor
- **Research**: competitive analysis, documentation summary, technical deep-dive
- **Ops**: deployment check, infrastructure audit, monitoring setup
- **Writing**: draft, report, email copy, documentation
- **Data**: CSV analysis, data transformation, chart generation
- **General**: anything else

### 3. For each task, report

- What you asked for (exact prompt or close paraphrase)
- What the agent produced (screenshot of Works panel or copy of output)
- Outcome: correct, partially correct, incorrect, or failed
- Whether you understood what the agent did from the UI alone (without reading logs)

### 4. Report any task that

- Produced an incorrect or missing Work
- Failed without a clear error message
- Took longer than expected with no progress indication
- Got stuck in a state you couldn't recover from (required page refresh, restart, etc.)

### 5. Report any UI moment where you

- Didn't know what to do next
- Couldn't tell whether the agent was working or stuck
- Expected a feature that didn't exist
- Found the interface confusing or misleading

## What We're Looking For

- **Setup friction**: Where does the self-host guide fail? What's missing?
- **Task execution quality**: Does the agent do what you ask?
- **Works output quality**: Is the deliverable useful and correct?
- **UI clarity**: Where does the interface lose you?
- **Recovery**: When something goes wrong, can you tell what happened and what to do?

## Completion

Testers who do not submit the feedback form within the 2-week window are replaced for Cohort 2. Partial responses are accepted but complete responses are strongly preferred.
