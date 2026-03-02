INSERT INTO providers (code, name, base_url)
VALUES
  ('openai', 'OpenAI', 'https://api.openai.com/v1'),
  ('grok2api', 'Grok2API', 'https://gapi.lyxnb.de5.net/v1')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    base_url = EXCLUDED.base_url;
