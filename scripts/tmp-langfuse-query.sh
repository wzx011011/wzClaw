#!/bin/bash
DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker

echo "=== DATASET RUNS ==="
$DOCKER exec langfuse-postgres-1 psql -U postgres -c "SELECT dr.id, p.name as project, ds.name as dataset, dr.name as run_name, dr.created_at FROM dataset_runs dr JOIN datasets ds ON dr.dataset_id = ds.id JOIN projects p ON ds.project_id = p.id ORDER BY dr.created_at DESC;" 2>/dev/null

echo ""
echo "=== DATASETS ==="
$DOCKER exec langfuse-postgres-1 psql -U postgres -c "SELECT p.name as project, d.name as dataset, d.created_at FROM datasets d JOIN projects p ON d.project_id = p.id ORDER BY d.created_at DESC;" 2>/dev/null

echo ""
echo "=== PROJECTS ==="
$DOCKER exec langfuse-postgres-1 psql -U postgres -c "SELECT id, name FROM projects;" 2>/dev/null
