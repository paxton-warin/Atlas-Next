WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY user_id, link_id
      ORDER BY assigned_at, id
    ) AS duplicate_number
  FROM link_assignments
  WHERE active
)
UPDATE link_assignments
SET active = false,
    replaced_at = COALESCE(replaced_at, now())
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE duplicate_number > 1
);

CREATE UNIQUE INDEX assignments_one_active_link_per_user
  ON link_assignments(user_id, link_id)
  WHERE active;
