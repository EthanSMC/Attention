import {z} from "zod";

/** Published skill versions accepted by both Registry and the owned reader gateway. */
export const AttentionSkillVersionSchema = z.enum([
  "1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0", "1.8.0", "1.9.0", "1.10.0",
]);
