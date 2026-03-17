TOKEN=$(ssh -i ~/.ssh/id_antigravity -o StrictHostKeyChecking=no root@15.204.88.123 "docker exec coolify-db psql -U coolify -tAc \"SELECT token FROM personal_access_tokens LIMIT 1;\"")
ssh -i ~/.ssh/id_antigravity -o StrictHostKeyChecking=no root@15.204.88.123 "curl -s -X POST -H \"Authorization: Bearer $TOKEN\" \"http://localhost:8000/api/v1/deploy?uuid=gqofxnij3kbkb2ge7tsmu5sn&force=1\""
