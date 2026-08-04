CREATE INDEX "content_reports_reporter_created_idx" ON "content_reports" USING btree ("reporter_account_id","created_at");
