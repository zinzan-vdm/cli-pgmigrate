ALTER TABLE users ADD COLUMN name TEXT;

INSERT INTO users (email, name) VALUES ('alice@test.com', 'Alice');
INSERT INTO users (email, name) VALUES ('bob@test.com', 'Bob');