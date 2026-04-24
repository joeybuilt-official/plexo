-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Register SSH as a connection type. Enables agents to connect to
-- remote servers, execute commands, and transfer files via SFTP.
-- Lightweight — single INSERT, no schema changes.

INSERT INTO connections_registry (id, name, description, category, auth_type, setup_fields, tools_provided, is_core)
VALUES (
    'ssh',
    'SSH Server',
    'Connect to a remote server via SSH. Execute commands, transfer files, manage infrastructure.',
    'infrastructure',
    'api_key',
    '[
        {"key":"host","label":"Host or IP address","type":"text","required":true,"placeholder":"192.168.1.100 or myserver.com"},
        {"key":"port","label":"Port","type":"number","required":false,"placeholder":"22"},
        {"key":"username","label":"Username","type":"text","required":true,"placeholder":"root"},
        {"key":"auth_method","label":"Authentication","type":"select","required":true,"options":["Private Key","Password"]},
        {"key":"private_key","label":"Private Key (PEM)","type":"textarea","required":false,"placeholder":"-----BEGIN OPENSSH PRIVATE KEY-----"},
        {"key":"password","label":"Password","type":"password","required":false},
        {"key":"mode","label":"Access Level","type":"select","required":true,"options":["Full Access","Read Only"]}
    ]'::jsonb,
    '["ssh__exec","ssh__upload","ssh__download","ssh__list_dir"]'::jsonb,
    true
)
ON CONFLICT (id) DO NOTHING;
