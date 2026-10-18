# Held combined release, October 17, 2026

Public-build support and typed events have been combined locally. This record
is verification evidence, not a publication or deployment record.

Validated: 313 Node tests after the held 0.5.1 remote-config integration audit.

Doctor warns on literal caller-supplied `rs_exp_*` event properties and leaves
config calls out of event coverage. Focused regressions cover both behaviors.
Static scans do not verify live assignments, consent transitions or SDK cache
behavior; dynamic properties and typed-helper extras are not covered by this
new warning. No authenticated or production calls were made.

The merge preserves public-key consent and inert-without-key behavior,
stable event IDs, typed event helpers and opt-in performance sampling.
JavaScript now defers performance listeners until consent; Android health
summaries carry the same deduplication IDs as other events.

Physical-device and live-service validation is not implied by these checks.
Publishing, tags, marketplace submission and deployments remain held pending
owner approval. Older README test counts describe their earlier branch runs;
this file records the combined candidate.
