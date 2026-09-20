# Klyro — project constitution (PROJECT NAME IS Klyro, not Perf Lab)

## What this is
An AWS-native pipeline that, given a Node/Express/Postgres demo app with two
deliberately seeded performance issues, automatically: builds it, deploys it
to an isolated ECS environment, load-tests it, uses two LLM calls to
diagnose and propose a code fix, rebuilds/redeploys/retests with the
fix, and produces a deterministic before/after verdict.

## Stack
- Infra: AWS CDK, TypeScript, one app under infra/. cdk.json's
  `@aws-cdk/core:validateAgainstDefaultRules` context flag is deliberately
  `false` (not the CDK-generated default of `true`) — with it on, this
  CDK CLI version (2.1142.0) crashes on every synth/deploy with
  `IllegalPluginOperation: One of the validation plugins (Construct
  Annotations) modified the cloud assembly`, a real bug in that
  built-in plugin, not something in this project's own stacks. The flag
  only gates an extra local pre-deploy lint pass (no effect on deployed
  resources), so turning it off is a real fix, not a masked error.
- Compute: ECS on Fargate (app service, db service, k6 task, db-init task)
- Build: a persistent EC2 instance (Amazon Linux 2023 + Docker), driven by
  SSM RunCommand (`AWS-RunShellScript`), running the same build/patch/push
  logic a CodeBuild buildspec would. Originally speced as CodeBuild
  (privileged mode + local Docker layer cache); switched because this
  AWS account's CodeBuild concurrent-build quota is 0 in every region and
  AWS Support denied the increase request outright, recommending "at
  least one billing cycle" of general account usage first — not a wait
  the project had time for. EC2's on-demand vCPU quota was already
  non-zero, so an always-on builder instance reached by SendCommand
  sidesteps CodeBuild's abuse-prevention gate entirely while keeping the
  same source-zip-plus-in-place-patch build model.
- Orchestration: Step Functions, using `.sync` service integrations for
  ECS RunTask wherever possible — do not write custom Lambda polling
  loops for task completion. SSM RunCommand has no `.sync` integration
  pattern, so the build step's completion is polled via a bounded
  Wait/Choice loop (`ssm:sendCommand` then `ssm:getCommandInvocation`),
  the same hand-built pattern already used for ECS service rollout
  stabilization — this is the one deliberate exception to "no custom
  polling loops," made because no `.sync` alternative exists for SSM.
- LLM: a rotating POOL of provider+model+key entries per agent (Analyst,
  Investigator), not one fixed provider — see lambdas/llm-provider/
  index.js's LLMProvider class. Each pool entry is
  `{ apiKey, baseUrl, model }`; on a 429 from the entry currently in use,
  LLMProvider rotates to the next entry and retries the same prompt
  immediately, cycling through the whole pool before falling back to one
  backoff-and-retry. History: originally speced as Groq, swapped to
  Mistral (the user had a key in hand with expected-better limits), then
  Mistral's account came back rate-limited to 0 req/minute — not
  something either provider's dashboard fixes on demand. Rather than pick
  a single provider again, the pool now holds 2 Mistral keys + 2 Groq
  keys at once, spanning both providers, so a 429 on one provider's
  entire account still has somewhere to rotate to. This is a deliberate,
  narrow exception to "never silently switch models or providers
  mid-run" below: the pool and its ordering are configured up front, not
  improvised at failure time, and schema-repair retries (the actual
  "the model got it wrong" case that rule is about) still stay on the
  SAME pool entry, never rotate.
- Storage: S3 (all artifacts keyed by runId), SSM Parameter Store
  (SecureString) for the LLM key pools — never a plaintext env var. Two
  parameters, /klyro/llm-key-pool-analyst and
  /klyro/llm-key-pool-investigator, each a JSON array of pool entries
  (Analyst's entries use each provider's smaller/faster model, e.g.
  mistral-small-latest / openai/gpt-oss-20b; Investigator's use each
  provider's larger one, e.g. mistral-large-latest /
  openai/gpt-oss-120b — Groq's actually-available model catalog was
  checked live via GET /v1/models rather than assumed) — adding,
  removing, or reordering keys is an SSM update, not a redeploy.
- Dashboard: dashboard/ is a real React + Vite + TypeScript app (this
  superseded an earlier single-static-file, no-build-step design — see
  git history). Stack: Tailwind CSS v3 (classic config, not v4 — chosen
  for compatibility with Tremor's documented setup, which still targets
  v3), shadcn/ui (new-york style, dark-only — see below), Tremor
  (@tremor/react) for charts/KPI cards, motion (the current Framer
  Motion, imported from "motion/react") for the AnimatedNumber
  count-up/down and card entrance animation, lucide-react for icons,
  sonner for toasts. components/AnimatedNumber.tsx and
  components/StatusBadge.tsx are the two reusable primitives everything
  else builds on — every numeric readout in the app should go through
  AnimatedNumber (font-mono, unit-aware: ms/%/req-s), and every
  pending/active/done/failed/validated/rejected state through
  StatusBadge, rather than ad hoc spans. src/App.tsx is wired to the live
  HTTP API: POST /run to start a run, GET /status/{runId} polled while it
  runs, then runs/<runId>/report.json fetched directly from S3 (public-read
  on that one key pattern) once the execution is terminal.
- Dashboard design tokens (src/index.css): background #0A0B0E, card
  #12141A (slightly lighter, with a border-glow on hover/active via the
  .card-glow class + data-state="baseline"|"optimized"), two gradients —
  cyan-to-violet (#22D3EE → #8B5CF6) for "baseline" state, amber-to-green
  (#F59E0B → #22C55E) for "optimized/validated" state. Fonts: Geist Sans
  for labels, Geist Mono for every numeric value, both loaded via Google
  Fonts with ui-sans-serif/ui-monospace fallback stacks. Dark mode is the
  only theme — `<html class="dark">` is set permanently in index.html,
  no toggle component exists; darkMode:'class' stays in tailwind.config
  only because Tremor's own components ship internal dark: variants that
  expect the class to be present.
- Dashboard deploy: data-stack.ts's BucketDeployment now uploads
  dashboard/dist (the built Vite app — run `npm run build` in dashboard/
  before every `cdk deploy` of DataStack, or it uploads a stale build;
  there's no build step wired into the CDK deploy itself). Served
  publicly via CloudFront (DashboardDistribution) in front of the same
  runs bucket's dashboard/ prefix, through Origin Access Control (OAC) —
  the modern replacement for OAI. originPath scopes every request the
  distribution makes to dashboard/, so runs/* stays unreachable through
  it even though the L2 origin construct's auto-generated bucket-policy
  statement is technically s3:GetObject on the whole bucket (conditioned
  on the distribution's own ARN, not key prefix — CDK doesn't expose a
  narrower option here). Cache policy is a short 1-5min TTL, not the
  default CACHING_OPTIMIZED, since there's no CloudFront invalidation
  step after a deploy — a short TTL is what makes a redeploy actually
  show up. DashboardUrl (a CfnOutput) is the real public entry point now;
  the presigned-URL approach from before CloudFront existed still works
  as a fallback but isn't the primary access path anymore.
- HTTP API: OrchestrationStack's TriggerHttpApi (apigatewayv2, not a v1
  REST API — every new route lands on the same HTTP API that already
  served POST /run, rather than standing up a separate REST API, to keep
  one API surface instead of several) serves POST /run (trigger/, starts
  a new execution), GET /status/{runId} (status/, polls one), and GET
  /runs (list-runs/, run history). No auth on any of them — this is a
  judge-facing demo control plane, not multi-tenant, and none of the
  three routes can read or mutate another run's data beyond what's
  already public via report.json. CORS is origin '*' on all of them:
  even now that DashboardDistribution (above) gives the dashboard a real
  fixed domain, allowlisting it isn't obviously worth the coupling for a
  demo project with no auth either way, so this was left as-is rather
  than tightened. The dashboard reads the API's base URL from
  VITE_API_BASE_URL (dashboard/.env, gitignored — see .env.example), set
  from OrchestrationStack's HttpApiUrl output.
- lambdas/list-runs/: lists runs/ via ListObjectsV2 (s3:ListBucket scoped
  to the runs/ prefix via an s3:prefix condition — same pattern
  report-writer's grant already uses, not bucket-wide), filters for keys
  ending in /report.json (one per completed run), reads each one
  (s3:GetObject scoped to runs/*/report.json) for its verdict, and
  returns {runId, timestamp, verdict, guardRejected} sorted newest first.
- lambdas/status/: given a runId, derives the Step Functions execution
  ARN deterministically (swap ":stateMachine:" for ":execution:" on
  STATE_MACHINE_ARN, append runId) rather than searching for it — this
  works because trigger/ always names executions after runId. Calls
  DescribeExecution + GetExecutionHistory, then collapses the ASL's ~45
  real state names (statemachine/experiment.asl.json) down to 10
  human-facing stages: Build, Deploy, Load Test, Diagnose, Patch,
  Rebuild, Redeploy, Reset, Retest, Evaluate — MarkFailed/
  ExperimentSucceeded/ExperimentFailed are deliberately excluded as
  bookkeeping, not a stage. A stage is 'done' if any earlier stage's
  states were entered more recently, 'active'/'failed' at whichever stage
  the execution is currently in or died in (branching on overallStatus),
  and 'pending' after that — see the STAGE_DEFINITIONS comment in
  lambdas/status/index.js for the full mapping, including why
  SeedDatabaseBaseline (runs in Parallel alongside BuildBaselineImage)
  is folded into Build rather than getting its own stage.
- Dashboard live-progress: PipelineView (src/components/PipelineView.tsx)
  renders the 10 stages from GET /status/{runId} as a horizontal node row
  with flowing-gradient connectors; usePipelineStatus polls it every 2s
  while overallStatus is RUNNING and stops on any terminal status. Once
  terminal, the dashboard starts polling report.json instead (see
  useReportPolling) and swaps PipelineView out for VerdictView — that
  swap on report.json's arrival is the whole "auto-navigate to the
  verdict view" behavior; there's no client-side router.

## Non-negotiable invariants
- Every artifact, image tag, and metric is keyed by `runId`
  (format: klyro-<unix-ts>-<6-char-hash>).
- Before and after runs must use identical workload, identical
  infrastructure (task CPU/memory/replica count fixed), and identical
  database state — db-init must be idempotent (DROP/CREATE SCHEMA + seed,
  not INSERT-only).
- The Investigator LLM may only modify files in this allowlist:
  demo-app/src/orders.js, demo-app/src/logger.js,
  demo-app/config/logger.json. Any other file path is rejected before
  any build step runs.
- Every patch must include original_sha256 of the file it targets, verified
  against the current file before it's applied.
- The Evaluator is deterministic code, never an LLM call. It distinguishes
  "performance changed" from "optimization validated" — validated requires
  p95 improvement ≥10%, error-rate delta ≤0.5 percentage points, and CPU
  staying ≤95%, all under the same workload/data/infra.
- Lambdas that call an LLM provider stay outside the VPC — no NAT gateway
  needed for the LLM calls.
- IAM: least privilege everywhere, especially the k6 task role
  (s3:PutObject scoped to runs/<runId>/* only, nothing broader).

## Conventions
- All Lambdas: Node 20, one handler per directory under lambdas/.
- Lambda code is packaged from lambdas/ as a whole, so modules under
  lambdas/shared/ are requirable from every handler with no bundler and no
  dependency. Pure logic worth testing lives there and stays free of any
  AWS import — handlers pull in @aws-sdk/* at module load, which only
  resolves inside the Lambda runtime, so anything importing a handler
  cannot run locally. That is why evaluate() is in shared/verdict.js and
  verifyPatch() is in shared/patchGuard.js taking its manifest as a
  parameter rather than requiring the gitignored generated one.
- Tests live in tests/ and use Node's built-in runner (`npm test` at the
  repo root). No install, no AWS, no cdk synth required.
- All JSON the LLMs must produce is validated against a fixed schema in
  code; on a parse/validation failure, retry the same call once (same
  pool entry) with the error appended to the prompt, then mark the run
  AI_FAILED — never improvise a switch to a model/provider outside the
  pre-configured pool mid-run. Rotating across the pool itself on a rate
  limit (see LLM section above) is the one sanctioned exception.
- Keep everything in `ap-south-1` (Mumbai — closest region to the user,
  chosen over the original us-east-1 default) unless told otherwise.
  infra/bin/klyro.ts reads KLYRO_REGION, deliberately NOT
  CDK_DEFAULT_REGION: the CDK CLI injects the latter into the app's
  environment from whatever region the caller's profile resolves to
  (us-east-1 when none is configured), so an `|| 'ap-south-1'` fallback on
  it could never actually be reached and a differently-configured profile
  would silently deploy everything to the wrong region.