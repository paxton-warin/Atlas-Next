UPDATE app_settings
SET value = value - 'linksPerHour'
WHERE key = 'assignments';
