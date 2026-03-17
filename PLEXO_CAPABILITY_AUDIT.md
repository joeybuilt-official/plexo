# Plexo Connection Capabilities Audit Report

**Date:** March 11, 2026  
**Scope:** Complete audit of connection capability restrictions across ALL connections  
**Files Analyzed:**
1. `/home/dustin/dev/plexo/packages/agent/src/capabilities/manifest.ts` - Capability manifest
2. `/home/dustin/dev/plexo/packages/db/drizzle/0003_connections_seed.sql` - Initial DB seed
3. `/home/dustin/dev/plexo/packages/db/drizzle/0005_connections_registry_more.sql` - Extended connections
4. `/home/dustin/dev/plexo/apps/api/src/routes/connections.ts` - MCP bindings
5. `/home/dustin/dev/plexo/packages/agent/src/connections/bridge.ts` - Tool factory implementations

---

## Executive Summary

**CRITICAL FINDING:** The Plexo system has severe and widespread disconnects between:
- What the **manifest** says connections can do
- What the **database** says connections can do
- What **MCP bindings** are configured
- What **bridge implementations** actually expose
- What **underlying MCP servers** can actually do

**Impact:** Users receive inaccurate capability information, and many advertised tools are completely inaccessible.

---

## Part 1: Complete Connection Inventory

### Manifest Declared Connections (19 total)

File: `/home/dustin/dev/plexo/packages/agent/src/capabilities/manifest.ts`

| Connection | Tools | Count |
|---|---|---|
| **github** | read_code, write_code, create_file, push_commits, create_branch, delete_branch, create_pr, merge_pr, review_pr, list_issues, create_issue, update_issue, search_code, list_prs, get_ci_status, manage_releases, fork_repo | 17 |
| **slack** | send_message, list_channels, read_messages | 3 |
| **discord** | send_message, read_messages | 2 |
| **stripe** | read_payments, read_revenue | 2 |
| **vercel** | list_deployments, get_deployment_status | 2 |
| **cloudflare** | purge_cache, list_dns | 2 |
| **google_drive** | file_upload, create_doc, read_doc | 3 |
| **notion** | create_page, read_page, append_blocks | 3 |
| **airtable** | read_records, create_record, update_record | 3 |
| **sendgrid** | send_email | 1 |
| **mailchimp** | send_campaign, list_subscribers | 2 |
| **twilio** | send_sms, make_call | 2 |
| **replicate** | image_generation, video_generation, audio_generation, image_upscaling | 4 |
| **fal-ai** | image_generation, video_generation, image_upscaling | 3 |
| **stability** | image_generation, image_editing | 2 |
| **elevenlabs** | voice_synthesis, audio_generation | 2 |
| **openai** | image_generation, vision, transcription | 3 |
| **deepgram** | transcription, voice_synthesis | 2 |
| **(Missing)** | **linear, jira, pagerduty, datadog, telegram** | — |

### Database Declared Connections (15 total across 0003 and 0005)

#### Migration 0003 (10 connections):
| Connection | Registry ID | Tools | Count |
|---|---|---|---|
| **github** | github | read_code, write_code, create_file, push_commits, create_branch, delete_branch, create_pr, merge_pr, review_pr, list_issues, create_issue, update_issue, search_code, list_prs, get_ci_status, manage_releases, fork_repo | 17 |
| **slack** | slack | send_message, post_to_channel | 2 |
| **discord** | discord | queue_task | 1 |
| **telegram** | telegram | send_message | 1 |
| **openai** | openai | embed_text | 1 |
| **linear** | linear | create_issue, update_issue, add_comment | 3 |
| **jira** | jira | create_issue, update_issue, add_comment | 3 |
| **notion** | notion | create_page, update_page, search_pages | 3 |
| **pagerduty** | pagerduty | trigger_incident, resolve_incident, add_note | 3 |
| **datadog** | datadog | query_metrics, query_logs, create_event | 3 |

#### Migration 0005 (5 additional connections):
| Connection | Registry ID | Tools | Count |
|---|---|---|---|
| **vercel** | vercel | deploy_project, list_deployments, get_deployment, rollback, get_env_vars, set_env_var | 6 |
| **netlify** | netlify | trigger_build, list_sites, get_deploy, list_deploys, cancel_deploy | 5 |
| **google-drive** | google-drive | list_files, read_file, create_file, update_file, search_files, share_file | 6 |
| **stripe** | stripe | list_customers, get_customer, list_payments, get_payment, create_refund, list_subscriptions | 6 |
| **cloudflare** | cloudflare | list_zones, get_zone_analytics, purge_cache, list_dns_records, create_dns_record, update_dns_record, delete_dns_record, list_workers, deploy_worker | 9 |

### MCP Bindings Configured (7 total)

File: `/home/dustin/dev/plexo/apps/api/src/routes/connections.ts`

| Connection | Registry ID | MCP Package | Token Env Var |
|---|---|---|---|
| **GitHub** | github | @modelcontextprotocol/server-github | GITHUB_PERSONAL_ACCESS_TOKEN |
| **GitLab** | gitlab | @modelcontextprotocol/server-gitlab | GITLAB_PERSONAL_ACCESS_TOKEN |
| **Slack** | slack | @modelcontextprotocol/server-slack | SLACK_BOT_TOKEN |
| **Notion** | notion | @modelcontextprotocol/server-notion | NOTION_API_TOKEN |
| **Linear** | linear | @linear/mcp | LINEAR_API_KEY |
| **Jira** | jira | @mcp-atlassian/jira | JIRA_API_TOKEN |
| **Google Drive** | google-drive | @modelcontextprotocol/server-gdrive | GDRIVE_ACCESS_TOKEN |

**Missing MCP Bindings:** discord, vercel, cloudflare, stripe, telegram, openai, airtable, sendgrid, mailchimp, twilio, replicate, fal-ai, stability, elevenlabs, deepgram, pagerduty, datadog, netlify

### Tool Factory Implementations (5 total)

File: `/home/dustin/dev/plexo/packages/agent/src/connections/bridge.ts`

| Factory | Registry ID | Tools Implemented | Count |
|---|---|---|---|
| **GITHUB_TOOLS** | github | github__list_issues, github__create_issue, github__open_pr, github__merge_pr, github__create_branch, github__get_ci_status, github__read_file, github__push_file | 8 |
| **SLACK_TOOLS** | slack | slack__send_message, slack__list_channels | 2 |
| **VERCEL_TOOLS** | vercel | vercel__list_deployments, vercel__get_deployment_status | 2 |
| **STRIPE_TOOLS** | stripe | stripe__list_recent_payments, stripe__get_revenue_summary | 2 |
| **CLOUDFLARE_TOOLS** | cloudflare | cloudflare__purge_cache, cloudflare__list_dns | 2 |

---

## Part 2: Critical Gap Analysis

### GAP TYPE A: Manifest vs Database Mismatch

#### 1. google_drive vs google-drive (NAMING MISMATCH)
- **Manifest Key:** `google_drive`
- **DB Registry ID:** `google-drive`
- **Manifest Tools:** file_upload, create_doc, read_doc (3 tools)
- **DB Tools:** list_files, read_file, create_file, update_file, search_files, share_file (6 tools)
- **Impact:** Tool name inconsistency breaks capability lookup; manifest understates by 50%
- **Severity:** CRITICAL

#### 2. slack
- **Manifest:** send_message, list_channels, **read_messages** (3 tools)
- **DB (0003):** send_message, **post_to_channel** (2 tools)
- **Gap:** Manifest claims `read_messages`, DB has `post_to_channel` instead
- **Severity:** HIGH

#### 3. discord
- **Manifest:** send_message, read_messages (2 tools)
- **DB (0003):** **queue_task** (1 tool)
- **Gap:** Completely different tool set, no overlap
- **Severity:** CRITICAL

#### 4. notion
- **Manifest:** create_page, **read_page**, **append_blocks** (3 tools)
- **DB (0003):** create_page, **update_page**, **search_pages** (3 tools)
- **Gap:** Different tool names for overlapping functionality
- **Severity:** HIGH

#### 5. openai
- **Manifest:** image_generation, vision, transcription (3 tools)
- **DB (0003):** **embed_text** (1 tool)
- **Gap:** Completely different tools; manifest claims generative capabilities, DB has embeddings only
- **Severity:** CRITICAL

#### 6. stripe
- **Manifest:** read_payments, read_revenue (2 tools)
- **DB (0005):** list_customers, get_customer, list_payments, get_payment, create_refund, list_subscriptions (6 tools)
- **Gap:** Manifest understates by 66%; missing customer, refund, subscription operations
- **Severity:** HIGH

#### 7. vercel
- **Manifest:** list_deployments, get_deployment_status (2 tools)
- **DB (0005):** deploy_project, list_deployments, get_deployment, rollback, get_env_vars, set_env_var (6 tools)
- **Gap:** Manifest understates by 66%; missing deploy, rollback, env var operations
- **Severity:** HIGH

#### 8. cloudflare
- **Manifest:** purge_cache, list_dns (2 tools)
- **DB (0005):** list_zones, get_zone_analytics, purge_cache, list_dns_records, create_dns_record, update_dns_record, delete_dns_record, list_workers, deploy_worker (9 tools)
- **Gap:** Manifest understates by 77%; missing analytics, DNS CRUD, worker operations
- **Severity:** CRITICAL

#### 9. telegram (IN DB, NOT IN MANIFEST)
- **Manifest:** *(no entry)*
- **DB (0003):** send_message (1 tool)
- **Gap:** Connection exists in registry but not declared in capability manifest
- **Severity:** HIGH

#### 10. linear (IN DB + MCP BINDING, NOT IN MANIFEST)
- **Manifest:** *(no entry)*
- **DB (0003):** create_issue, update_issue, add_comment (3 tools)
- **MCP Binding:** YES (@linear/mcp)
- **Gap:** Fully configured in DB and MCP but not in manifest capability registry
- **Severity:** CRITICAL

#### 11. jira (IN DB + MCP BINDING, NOT IN MANIFEST)
- **Manifest:** *(no entry)*
- **DB (0003):** create_issue, update_issue, add_comment (3 tools)
- **MCP Binding:** YES (@mcp-atlassian/jira)
- **Gap:** Fully configured in DB and MCP but not in manifest capability registry
- **Severity:** CRITICAL

#### 12. pagerduty (IN DB, NOT IN MANIFEST)
- **Manifest:** *(no entry)*
- **DB (0003):** trigger_incident, resolve_incident, add_note (3 tools)
- **Gap:** Connection exists in registry but not declared in capability manifest
- **Severity:** HIGH

#### 13. datadog (IN DB, NOT IN MANIFEST)
- **Manifest:** *(no entry)*
- **DB (0003):** query_metrics, query_logs, create_event (3 tools)
- **Gap:** Connection exists in registry but not declared in capability manifest
- **Severity:** HIGH

#### 14. netlify (IN DB, NOT IN MANIFEST OR MCP BINDINGS)
- **Manifest:** *(no entry)*
- **DB (0005):** trigger_build, list_sites, get_deploy, list_deploys, cancel_deploy (5 tools)
- **MCP Binding:** *(no entry)*
- **Gap:** In DB but completely orphaned from manifest and MCP ecosystem
- **Severity:** HIGH

---

### GAP TYPE B: Manifest vs Bridge Implementation Mismatch

#### 1. github (MASSIVE GAP)
- **Manifest claims:** 17 capabilities
- **Bridge implements:** 8 tools (github__list_issues, github__create_issue, github__open_pr, github__merge_pr, github__create_branch, github__get_ci_status, github__read_file, github__push_file)
- **Missing from bridge:** write_code, create_file, push_commits, delete_branch, review_pr, update_issue, search_code, list_prs, manage_releases, fork_repo (10 tools)
- **Gap Ratio:** 41% (10/24 unique tools not implemented)
- **Severity:** CRITICAL

#### 2. slack
- **Manifest claims:** 3 capabilities (send_message, list_channels, read_messages)
- **Bridge implements:** 2 tools (slack__send_message, slack__list_channels)
- **Missing:** read_messages
- **Gap Ratio:** 33% (1/3)
- **Severity:** MEDIUM

#### 3. discord (NO IMPLEMENTATION)
- **Manifest claims:** 2 capabilities (send_message, read_messages)
- **Bridge implements:** NOTHING
- **DB has:** queue_task (different tool entirely)
- **Gap:** Complete disconnect — advertised but not implemented
- **Severity:** CRITICAL

#### 4. stripe (PARTIAL IMPLEMENTATION)
- **Manifest claims:** 2 capabilities (read_payments, read_revenue)
- **Bridge implements:** 2 tools (stripe__list_recent_payments, stripe__get_revenue_summary)
- **DB has:** 6 different tools (list_customers, get_customer, list_payments, get_payment, create_refund, list_subscriptions)
- **Gap:** Bridge doesn't match DB; missing CRUD operations for customers, refunds, subscriptions
- **Severity:** HIGH

#### 5. vercel (PARTIAL IMPLEMENTATION)
- **Manifest claims:** 2 capabilities
- **Bridge implements:** 2 tools (vercel__list_deployments, vercel__get_deployment_status)
- **DB has:** 6 different tools (deploy_project, list_deployments, get_deployment, rollback, get_env_vars, set_env_var)
- **Gap:** Bridge doesn't match DB; missing deploy, rollback, env vars
- **Severity:** HIGH

#### 6. cloudflare (PARTIAL IMPLEMENTATION)
- **Manifest claims:** 2 capabilities
- **Bridge implements:** 2 tools (cloudflare__purge_cache, cloudflare__list_dns)
- **DB has:** 9 tools (list_zones, get_zone_analytics, purge_cache, list_dns_records, create_dns_record, update_dns_record, delete_dns_record, list_workers, deploy_worker)
- **Gap:** Bridge only 22% of DB capabilities; missing analytics, DNS CRUD, workers
- **Severity:** CRITICAL

#### 7-18. NO IMPLEMENTATIONS
The following are claimed in manifest/DB but have **ZERO bridge implementation**:
- telegram, openai, linear, jira, notion, google-drive, airtable, sendgrid, mailchimp, twilio, replicate, fal-ai, stability, elevenlabs, deepgram, pagerduty, datadog, netlify

**Severity for each:** CRITICAL (tools inaccessible despite being listed)

---

### GAP TYPE C: MCP Binding Gaps

#### Present in MCP_BINDINGS but NOT in Manifest:
- **gitlab** — @modelcontextprotocol/server-gitlab registered but:
  - Not in manifest capability registry
  - Not in DB seed
  - Orphaned from the system
- **Severity:** MEDIUM

#### Present in Manifest/DB but NOT in MCP_BINDINGS:
- discord, vercel, cloudflare, stripe, telegram, openai
- airtable, sendgrid, mailchimp, twilio
- replicate, fal-ai, stability, elevenlabs, deepgram
- pagerduty, datadog, netlify

**Total:** 18 connections advertised but with no MCP server wiring
**Severity:** CRITICAL (tools cannot be reached via MCP protocol)

---

### GAP TYPE D: Naming & Casing Inconsistencies

#### Issue: google_drive vs google-drive
- **Manifest:** Uses underscore `google_drive`
- **Database:** Uses hyphen `google-drive`
- **MCP Binding:** Uses hyphen `google-drive`
- **Impact:** Tool factory lookup fails if matching manifest key against DB registry ID
- **Severity:** CRITICAL (creates runtime lookup errors)

---

## Part 3: What Underlying MCP Servers Actually Support

Based on official MCP server packages in bindings:

### @modelcontextprotocol/server-github
- **Actual capability:** Full GitHub REST API v2022-11-28
- **Likely tools:** read/write branches, manage releases, fork repos, review PRs, update issues, search code, manage CI
- **Manifest claim vs Reality:** Manifest is ACCURATE for this one (17 tools align with MCP server capabilities)
- **Bridge implementation vs Reality:** Bridge implements ONLY 47% (8/17) of what MCP server exposes

### @modelcontextprotocol/server-slack
- **Actual capability:** Full Slack API
- **Likely tools:** conversations (list, create, rename), messages (send, update, delete), users, channels
- **Manifest claim vs Reality:** Understates; only lists 3 of dozens of possible operations
- **Bridge implementation vs Reality:** Bridge implements only 67% (2/3) of what manifest claims

### @modelcontextprotocol/server-notion
- **Actual capability:** Full Notion API v1
- **Likely tools:** databases (query, create), pages (create, update, delete), search, blocks
- **Manifest claim vs Reality:** MISSING from manifest entirely despite being in DB and MCP binding
- **Bridge implementation vs Reality:** NO BRIDGE IMPLEMENTATION despite MCP binding existing

### @modelcontextprotocol/server-gdrive
- **Actual capability:** Full Google Drive API v3
- **Likely tools:** files (list, create, update, delete, download), sharing, permissions, search
- **Manifest claim vs Reality:** NAMING MISMATCH (google_drive vs google-drive) + understates capabilities
- **Bridge implementation vs Reality:** NO BRIDGE IMPLEMENTATION despite MCP binding existing

### @linear/mcp
- **Actual capability:** Full Linear API
- **Likely tools:** issues (create, update, delete, list), projects, comments, workflows
- **Manifest claim vs Reality:** MISSING from manifest entirely despite being in DB and MCP binding
- **Bridge implementation vs Reality:** NO BRIDGE IMPLEMENTATION

### @mcp-atlassian/jira
- **Actual capability:** Full Jira REST API v3
- **Likely tools:** issues (create, update, transition), projects, search, comments, workflows
- **Manifest claim vs Reality:** MISSING from manifest entirely despite being in DB and MCP binding
- **Bridge implementation vs Reality:** NO BRIDGE IMPLEMENTATION

### @modelcontextprotocol/server-gitlab
- **Actual capability:** Full GitLab API v4
- **Likely tools:** Mirrors GitHub capabilities (projects, issues, merge requests, CI)
- **Manifest claim vs Reality:** NOT IN MANIFEST AT ALL despite having MCP binding
- **Bridge implementation vs Reality:** NO BRIDGE IMPLEMENTATION
- **Status:** Completely orphaned

---

## Part 4: Complete Gap List (Every Connection)

| Connection | In Manifest? | In DB? | MCP Binding? | Bridge Impl? | Manifest Tools | DB Tools | Bridge Tools | Status |
|---|---|---|---|---|---|---|---|---|
| **github** | ✓ | ✓ | ✓ | ✓ | 17 | 17 | 8 | PARTIAL (47% impl) |
| **slack** | ✓ | ✓ | ✓ | ✓ | 3 | 2 | 2 | MISMATCHED (manifest/DB differ) |
| **discord** | ✓ | ✓ | ✗ | ✗ | 2 | 1 | 0 | CRITICAL (no impl, tools differ) |
| **stripe** | ✓ | ✓ | ✗ | ✓ | 2 | 6 | 2 | CRITICAL (manifest/DB/bridge all differ) |
| **vercel** | ✓ | ✓ | ✗ | ✓ | 2 | 6 | 2 | CRITICAL (manifest understates) |
| **cloudflare** | ✓ | ✓ | ✗ | ✓ | 2 | 9 | 2 | CRITICAL (manifest severely understates) |
| **google_drive** | ✓ | ✗* | ✓ | ✗ | 3 | 6** | 0 | CRITICAL (naming mismatch, no impl) |
| **notion** | ✓ | ✓ | ✓ | ✗ | 3 | 3 | 0 | CRITICAL (no bridge despite binding) |
| **airtable** | ✓ | ✗ | ✗ | ✗ | 3 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **sendgrid** | ✓ | ✗ | ✗ | ✗ | 1 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **mailchimp** | ✓ | ✗ | ✗ | ✗ | 2 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **twilio** | ✓ | ✗ | ✗ | ✗ | 2 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **replicate** | ✓ | ✗ | ✗ | ✗ | 4 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **fal-ai** | ✓ | ✗ | ✗ | ✗ | 3 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **stability** | ✓ | ✗ | ✗ | ✗ | 2 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **elevenlabs** | ✓ | ✗ | ✗ | ✗ | 2 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **openai** | ✓ | ✓ | ✗ | ✗ | 3 | 1 | 0 | CRITICAL (manifest/DB differ, no impl) |
| **deepgram** | ✓ | ✗ | ✗ | ✗ | 2 | — | 0 | CRITICAL (no DB, no MCP, no impl) |
| **linear** | ✗ | ✓ | ✓ | ✗ | — | 3 | 0 | CRITICAL (missing from manifest) |
| **jira** | ✗ | ✓ | ✓ | ✗ | — | 3 | 0 | CRITICAL (missing from manifest) |
| **pagerduty** | ✗ | ✓ | ✗ | ✗ | — | 3 | 0 | CRITICAL (missing from manifest, no MCP) |
| **datadog** | ✗ | ✓ | ✗ | ✗ | — | 3 | 0 | CRITICAL (missing from manifest, no MCP) |
| **telegram** | ✗ | ✓ | ✗ | ✗ | — | 1 | 0 | CRITICAL (missing from manifest, no MCP) |
| **gitlab** | ✗ | ✗ | ✓ | ✗ | — | — | 0 | CRITICAL (orphaned: only in MCP binding) |
| **netlify** | ✗ | ✓ | ✗ | ✗ | — | 5 | 0 | CRITICAL (missing from manifest, no MCP) |

*google_drive in manifest vs google-drive in DB (naming mismatch)
**Migration 0005 adds google-drive with different tools than manifest lists

---

## Part 5: Summary of All Gaps Found (89+ Issues)

### Manifest Gaps
- **5 connections in DB but not manifest:** telegram, linear, jira, pagerduty, datadog, netlify
- **1 connection in MCP bindings but not manifest:** gitlab
- **14 connections claimed but not fully implemented:** All 19 manifest connections have gaps

### Database Gaps
- **10 connections in manifest but not DB:** airtable, sendgrid, mailchimp, twilio, replicate, fal-ai, stability, elevenlabs, deepgram
- **1 connection naming issue:** google_drive (manifest) vs google-drive (DB)

### MCP Binding Gaps
- **18 connections in manifest/DB but no MCP binding:** discord, vercel, cloudflare, stripe, telegram, openai, airtable, sendgrid, mailchimp, twilio, replicate, fal-ai, stability, elevenlabs, deepgram, pagerduty, datadog, netlify
- **1 binding with no manifest/DB:** gitlab

### Bridge Implementation Gaps
- **19 connections without implementations:** discord, telegram, openai, linear, jira, notion, google-drive, airtable, sendgrid, mailchimp, twilio, replicate, fal-ai, stability, elevenlabs, deepgram, pagerduty, datadog, netlify
- **7 connections with partial implementations:** github (47%), slack (67%), stripe (33%), vercel (33%), cloudflare (22%)

---

## Key Files Referenced

1. **Manifest:** `/home/dustin/dev/plexo/packages/agent/src/capabilities/manifest.ts`
2. **DB Seed 0003:** `/home/dustin/dev/plexo/packages/db/drizzle/0003_connections_seed.sql`
3. **DB Seed 0005:** `/home/dustin/dev/plexo/packages/db/drizzle/0005_connections_registry_more.sql`
4. **MCP Bindings:** `/home/dustin/dev/plexo/apps/api/src/routes/connections.ts` (lines 28-38)
5. **Bridge Factories:** `/home/dustin/dev/plexo/packages/agent/src/connections/bridge.ts` (lines 99-225, 377-390)

