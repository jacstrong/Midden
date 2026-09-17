-- Chain-of-custody detail on attachments: a second hash (threat intel still keys on MD5), the
-- uploader's name as it was at the time, and an analyst note that can be edited afterwards.
ALTER TABLE attachments ADD COLUMN md5 TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN uploaded_by_name TEXT NOT NULL DEFAULT '';
ALTER TABLE attachments ADD COLUMN note TEXT NOT NULL DEFAULT '';
