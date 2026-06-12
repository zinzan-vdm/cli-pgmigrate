DELETE FROM users WHERE email IN ('alice@test.com', 'bob@test.com');
ALTER TABLE users DROP COLUMN name;