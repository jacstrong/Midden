-- Attachments flagged as dangerous (malware, weaponised documents) are stored unchanged but
-- served wrapped in an encrypted zip so nobody opens one by accident and no scanner eats it.
ALTER TABLE attachments ADD COLUMN dangerous INTEGER NOT NULL DEFAULT 0;
