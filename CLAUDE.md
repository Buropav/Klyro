# Klyro — project constitution (PROJECT NAME IS Klyro, not Perf Lab)

## What this is
An AWS-native pipeline that, given a Node/Express/Postgres demo app with two
deliberately seeded performance issues, automatically: builds it, deploys it
to an isolated ECS environment, load-tests it, uses two LLM calls to
diagnose and propose a code fix, rebuilds/redeploys/retests with the
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
- All JSON the LLMs must produce is validated against a fixed schema in
  code; on a parse/validation failure, retry the same call once (same
  pool entry) with the error appended to the prompt, then mark the run
  AI_FAILED — never improvise a switch to a model/provider outside the
  pre-configured pool mid-run. Rotating across the pool itself on a rate
  limit (see LLM section above) is the one sanctioned exception.
- Keep everything in `ap-south-1` (Mumbai — closest region to the user,
  chosen over the original us-east-1 default) unless told otherwise.