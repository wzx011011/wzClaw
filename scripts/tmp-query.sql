SELECT pr.name as project, ds.name as dataset, dr.name as run_name, dr.created_at
FROM dataset_runs dr
JOIN datasets ds ON dr.dataset_id = ds.id
JOIN projects pr ON ds.project_id = pr.id
ORDER BY dr.created_at DESC
LIMIT 40;
