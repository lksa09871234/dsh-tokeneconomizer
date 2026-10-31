# Fair before/after measurement

The plugin records what the harness reports; it does not prove an effect on cost
or quality by itself. This page defines how to measure that honestly. No savings
number is claimed in this repository because no controlled comparison has been
run.

## Question

Does enabling the plugin change (a) token usage and (b) task completion quality
in repositories you work in often, compared with the same agent and model
without it?

## Design

Run *pairs* of sessions on comparable work, one with the plugin's mechanisms
enabled and one with them disabled, in the same repository, with the same model
route and settings:

1. Choose a task set. Prefer real recurring work in one repository (for example
   ten small, independent tasks with a clear pass/fail check). If you use a
   benchmark, use its official grader; do not substitute self-grading.
2. Create two isolated profiles (`control`, `treatment`) or use `TE_DISABLE=1`
   for the control, so the difference is only the plugin. Keep the same
   `DSH_HOME` model/credential configuration for both.
3. Randomize or alternate the order across tasks so warm caches and novelty do
   not always favour one arm. Keep the same starting commit and clean working
   tree for every run.
4. Record the run's outcome from the plugin's own ledger
   (`/tokeneconomizer usage` or `te usage` for the treatment; for the control,
   read the DSH session's reported usage directly, because the plugin is
   disabled).
5. Repeat enough pairs to see a stable sign; report medians and the full
   distribution, not a cherry-picked best run.

## Metrics

- **Usage**: sum the reported token categories (uncached input, cache read, cache
  write, output) per session and per task, plus the plugin's overhead tokens
  (`spiral_judge_tokens`, `optimizer_tokens`, etc.). Report both execution and
  overhead; the comparison is only fair if the plugin's own spend is included.
- **Quality**: the task's pass/fail check (test suite, grader, or a written
  rubric applied blind to the arm). Also track turns, tool calls, repeated
  failures, and whether the task was abandoned - these diagnose *why* a
  difference appears.
- **Cost in currency**: only if you supply verified prices for your exact model
  route. This plugin does not embed prices; token counts are not money.

## Reporting template

| Task | Arm | Pass? | Input | Cache read | Cache write | Output | Plugin overhead | Effective tokens | Turns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Then report:

- paired median/mean difference in effective tokens and its spread;
- pass rate per arm and the exact grader used;
- plugin overhead share of total;
- obvious confounders (task order, model/version drift, cache warm-up, prompt
  changes) and any task excluded, with the reason.

## Honesty rules

- Do not compare a privileged arm with cache-warm prefixes against a cold control
  without saying so; cache reads are billed differently.
- Do not report "savings" from the plugin's overhead-inclusive total unless the
  control arm was measured the same way.
- Do not publish a percentage based on one pair or on self-selected tasks.
- If the data is missing (no provider usage), write "unknown", not zero.
- Quality claims require the same grader for both arms; an agent saying it
  finished is not a quality measurement.
