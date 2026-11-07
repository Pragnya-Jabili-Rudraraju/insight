# Evaluation dataset

`datasets/v1.json` is a versioned, controlled fixture set. Its source snippets are strings parsed as data; the evaluator never executes repository source. The fixtures currently cover parser diagnostics, dynamic execution, a possible hardcoded secret, unsafe TLS, removed exports, changed function signatures, and clean cases.

Run `npm run evaluate` from `backend/`. The report includes:

- Precision and recall on finding-location labels.
- Clean-case false-positive rate and false positives per pull request.
- Evidence source-reference validity and evidence accuracy against expected locations.
- Duplicate finding count.
- Mechanical patch application and syntax acceptance, plus invalid-patch rejection.

These values are a baseline only. The fixture set is small, hand-authored, and not representative of arbitrary projects. The patch metric does not test behavior or prove a proposed fix is correct. AI findings and provider variability have not been included in this baseline. Expand and review the labeled dataset using controlled repositories before setting quality thresholds.

## Baseline recorded 2026-11-07

Dataset `insight-eval-v1`: 10 cases (7 positive, 3 clean), 7 labeled expected findings.

| Metric | Result | Denominator |
|---|---:|---:|
| Precision | 7/7 = 1.00 | 7 predicted findings |
| Recall | 7/7 = 1.00 | 7 expected findings |
| Clean-case false-positive rate | 0/3 = 0.00 | 3 clean cases |
| Evidence accuracy | 7/7 = 1.00 | 7 accepted findings |
| Evidence reference validity | 7/7 = 1.00 | 7 accepted findings |
| Duplicate findings | 0 | 10 fixtures |
| Valid patch mechanical acceptance | 1/1 = 1.00 | 1 intended-valid patch |
| Invalid patch rejection | 1/1 = 1.00 | 1 intended-invalid patch |

Do not interpret these perfect scores as product-quality claims; they reflect only these ten deliberately constrained examples. No final precision or recall thresholds have been chosen.

## Maximum-input parser measurement

Recorded on 2026-11-07 using Node.js v26.10.0, macOS arm64, Jest: 41 files totaling exactly 20 MiB (40 files at 500 KiB plus one at 480 KiB) completed parse and structural analysis in 145 ms. The test enforces the configured 60-second operation budget as an upper bound for this analyzer fixture. This does not measure GitHub, MongoDB, LLM latency, memory ceilings, or end-to-end review time; assess those in a configured integration environment before release. The result does not justify worker threads at this stage.
