-- Lifecycle watermark for the bar that is still forming (engine/lifecycle.ts stepLifecycle).
-- With quotes pushed every few seconds, an open call is stepped many times inside one bar. Each pass
-- records how far the forming bar's high/low had got, and the next pass applies only the range made
-- since, so a high/low printed BEFORE an activation or T1 can't be counted again after it.
ALTER TABLE live_signals ADD COLUMN forming_t INTEGER;
ALTER TABLE live_signals ADD COLUMN forming_hi REAL;
ALTER TABLE live_signals ADD COLUMN forming_lo REAL;
