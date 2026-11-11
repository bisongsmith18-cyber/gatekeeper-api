INSERT INTO customers (full_name, email)
VALUES
  ('Sample Customer', 'customer@example.com'),
  ('Second Customer', 'second@example.com')
ON CONFLICT (email) DO NOTHING;
