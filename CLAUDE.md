# Klyro — project constitution (PROJECT NAME IS Klyro, not Perf Lab)

## What this is
An AWS-native pipeline that, given a Node/Express/Postgres demo app with two
deliberately seeded performance issues, automatically: builds it, deploys it
to an isolated ECS environment, load-tests it, uses two Mistral-hosted LLM
calls to diagnose and propose a code fix, rebuilds/redeploys/retests with the
fix, and produces a deterministic before/after verdict.

## Stack
- Infra: AWS CDK, TypeScript, one app under infra/
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
- LLM: Mistral API (OpenAI-compatible), models read from env vars
  LLM_MODEL_ANALYST and LLM_MODEL_INVESTIGATOR, defaulting to
  mistral-small-latest and mistral-large-latest. Access via a small
  LLMProvider interface (implemented by MistralProvider) so the provider
  is swappable later. Originally speced as Groq; switched because the
  user already had a Mistral key and expected better rate limits for this
  project's repeated-testing usage — the swap only touched base URL,
  model IDs, and the SSM parameter/env var names, confirming the
  LLMProvider abstraction actually does what it's for.
- Storage: S3 (all artifacts keyed by runId), SSM Parameter Store
  (SecureString) for the Mistral API key — never a plaintext env var.

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
- Lambdas that call Mistral stay outside the VPC — no NAT gateway needed
  for the LLM calls.
- IAM: least privilege everywhere, especially the k6 task role
  (s3:PutObject scoped to runs/<runId>/* only, nothing broader).

## Conventions
- All Lambdas: Node 20, one handler per directory under lambdas/.
- All JSON the LLMs must produce is validated against a fixed schema in
  code; on a parse/validation failure, retry the same call once with the
  error appended to the prompt, then mark the run AI_FAILED — never
  silently switch models or providers mid-run.
- Keep everything in `ap-south-1` (Mumbai — closest region to the user,
  chosen over the original us-east-1 default) unless told otherwise.