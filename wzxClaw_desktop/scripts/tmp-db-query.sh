#!/bin/bash
DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker
$DOCKER exec langfuse-postgres-1 psql -U postgres -d langfuse -c "SELECT pr.name as project, ds.name as dataset, dr.name as run_name FROM dataset_runs dr JOIN datasets ds ON dr.dataset_id=ds.id JOIN projects pr ON ds.project_id=pr.id ORDER BY dr.created_at DESC LIMIT 40;"
