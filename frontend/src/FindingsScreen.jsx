import { useState } from 'react';
import './App.css';

function shortSha(value) {
  return value ? `${value.slice(0, 12)}…` : 'Not available';
}

function findingId(finding) {
  return String(finding.id || finding._id);
}

function verificationLabel(finding) {
  if (finding.provenance === 'deterministic' && finding.verification === 'rule_checked') return 'Rule checked';
  if (finding.verification === 'evidence_checked') return 'Evidence checked';
  return 'AI hypothesis';
}

function ReviewStateMessage({ state, message, onBack, onRetry }) {
  const content = {
    loading: ['Reviewing the pull request', 'Fetching the pinned snapshot and running analysis.'],
    empty: ['No issues flagged', 'No accepted findings were returned for this review. This does not prove the change has no problems.'],
    permission: ['GitHub access is needed', message || 'Reconnect the configured account or check its access to this repository.'],
    stale: ['This pull request changed', message || 'The review is tied to an older revision. Start a new review for the current version.'],
    error: ['The review could not finish', message || 'Check the backend connection and review details, then try again.'],
  }[state] || ['Review unavailable', message || 'The review could not be displayed.'];

  return (
    <section className={`review-state state-${state}`} role="status" aria-live="polite">
      {state === 'loading' ? <span className="loading-spinner" aria-hidden="true" /> : <span className="review-state-mark" aria-hidden="true">{state === 'empty' ? '✓' : '!'}</span>}
      <div><h2>{content[0]}</h2><p>{content[1]}</p>
        <div className="review-state-actions">
          {onRetry && state !== 'loading' && <button className="button button-primary" type="button" onClick={onRetry}>Try again</button>}
          <button className="button button-quiet" type="button" onClick={onBack}>Back</button>
        </div>
      </div>
    </section>
  );
}

function QualitySummary({ execution }) {
  const quality = execution?.qualitySummary || {};
  const limits = quality.analysisLimits || [];
  const warnings = execution?.warnings || [];
  return (
    <section className="review-quality" aria-labelledby="quality-title">
      <div className="quality-heading"><div><span className="section-kicker">REVIEW QUALITY</span><h2 id="quality-title">{execution?.status === 'partial' ? 'Partial review' : 'Review complete'}</h2></div><span className={`execution-status status-${execution?.status}`}>{execution?.status}</span></div>
      <p className="quality-description">{quality.evidenceChecked || 0} evidence-checked · {quality.ruleChecked || 0} rule-checked · {quality.hypotheses || 0} AI hypotheses · {quality.analyzedChangedFiles || 0} changed files analyzed.</p>
      {(limits.length > 0 || warnings.length > 0) && (
        <details className="quality-details"><summary>Analysis limits and review notes</summary>
          {limits.length > 0 && <p>Limit or skip codes: {limits.join(', ')}</p>}
          <ul>{warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.code}:</strong> {warning.message}</li>)}</ul>
        </details>
      )}
      <details className="patch-revision-details"><summary>Snapshot and analyzer versions</summary><p>Base: <code>{execution?.baseSha || 'Not available'}</code><br />Head: <code>{execution?.headSha || 'Not available'}</code><br />Analyzer: <code>{execution?.analyzerVersion || 'Not available'}</code><br />Prompt: <code>{execution?.promptVersion || 'Not configured'}</code></p></details>
    </section>
  );
}

function PatchPreview({ patch, onClose }) {
  const [message, setMessage] = useState('');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(patch.proposedCode);
      setMessage('Suggested code copied.');
    } catch { setMessage('Copy is unavailable here. Select and copy the code instead.'); }
  }

  function handleDownload() {
    const filename = patch.path?.split('/').pop() || 'suggested-code.txt';
    const file = new Blob([patch.proposedCode], { type: 'text/plain' });
    const downloadUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
    setMessage('Suggested code downloaded.');
  }

  return (
    <section className="patch-preview" aria-label="Patch proposal">
      <div className="patch-preview-heading"><div><span className="finding-section-label">PATCH PROPOSAL</span><h3>Suggested replacement</h3></div><span className={`patch-status patch-status-${patch.validationStatus}`}>{patch.validationStatus === 'valid' ? 'Checks passed · behavior unverified' : patch.validationStatus}</span></div>
      <p className="patch-warning">{patch.validationMessage || 'This proposal is tied to the revision shown below. Review it before using it.'}</p>
      <p className="patch-file">{patch.path}</p>
      <div className="patch-code-grid">
        <div className="patch-code-panel"><h4>Original code</h4><pre><code>{patch.originalCode}</code></pre></div>
        <div className="patch-code-panel proposed-code-panel"><h4>Proposed code</h4><pre><code>{patch.proposedCode}</code></pre></div>
      </div>
      <details className="patch-revision-details"><summary>Revision details</summary><p>Expected head: <code>{patch.expectedHeadSha}</code><br />File hash: <code>{patch.expectedFileHash}</code><br />Provider: <code>{patch.providerName} / {patch.providerModel}</code></p></details>
      <div className="patch-actions"><button className="button button-quiet" type="button" onClick={handleCopy}>Copy code</button><button className="button button-quiet" type="button" onClick={handleDownload}>Download code</button><button className="inline-action" type="button" onClick={onClose}>Close</button><span aria-live="polite">{message}</span></div>
      <p className="patch-read-only">Insight does not apply this proposal or write to GitHub.</p>
    </section>
  );
}

function FindingCard({ finding, execution, getConcept, createPatch }) {
  const [conceptState, setConceptState] = useState('closed');
  const [concept, setConcept] = useState(null);
  const [conceptError, setConceptError] = useState('');
  const [patchConfirmation, setPatchConfirmation] = useState(false);
  const [patchState, setPatchState] = useState('idle');
  const [patchError, setPatchError] = useState('');
  const [patchProposal, setPatchProposal] = useState(null);
  const id = findingId(finding);
  const severity = String(finding.severity || 'info').toLowerCase();
  const pathMetadata = execution?.changedFiles?.find((file) => file.path === finding.path);
  const canProposePatch = finding.side === 'head'
    && ['completed', 'partial'].includes(execution?.status)
    && Boolean(execution?.headSha && pathMetadata?.headContentHash);

  async function toggleConcept() {
    if (conceptState === 'open') { setConceptState('closed'); return; }
    if (concept) { setConceptState('open'); return; }
    setConceptState('loading');
    setConceptError('');
    try {
      const response = await getConcept(id);
      setConcept(response);
      setConceptState('open');
    } catch (error) {
      setConceptState('error');
      setConceptError(error.message || 'Concept help could not load.');
    }
  }

  async function generatePatch() {
    setPatchState('loading');
    setPatchError('');
    try {
      const response = await createPatch(id, execution.headSha, pathMetadata.headContentHash);
      setPatchProposal(response.patchProposal);
      setPatchState('ready');
      setPatchConfirmation(false);
    } catch (error) {
      setPatchState('error');
      setPatchError(error.message || 'Patch proposal could not be created.');
    }
  }

  return (
    <article className="finding-card">
      <div className="finding-card-heading"><div className="finding-severity-group"><span className={`finding-severity severity-${severity}`}>{finding.severity}</span><span className="finding-category">{finding.category}</span></div><span className="finding-validation">{verificationLabel(finding)}</span></div>
      <h2 className="finding-title">{finding.title}</h2>
      <p className="finding-location">{finding.path} · {finding.side === 'base' ? 'Base' : 'Head'} lines {finding.startLine}{finding.endLine !== finding.startLine ? `–${finding.endLine}` : ''}</p>
      <p className="finding-explanation">{finding.explanation}</p>

      {finding.impactTrail?.length > 0 && <div className="finding-impact"><span className="finding-section-label">WHAT IT COULD AFFECT</span><div className="impact-chain">{finding.impactTrail.map((item, index) => <span className="impact-step" key={`${item.path}-${index}`}>{index > 0 && <span className="impact-arrow" aria-hidden="true">→</span>}<span><strong>{item.path}</strong><small>{item.explanation}</small></span></span>)}</div></div>}

      {finding.suggestedImprovement && <div className="finding-suggestion"><span className="finding-section-label">SUGGESTED NEXT STEP</span><p>{finding.suggestedImprovement}</p></div>}
      <div className="finding-test"><span className="finding-section-label">REGRESSION TEST</span>
        {finding.testCode ? <details className="finding-evidence"><summary>Show suggested test code</summary><p>Suggested test code. Insight has not run it.</p><pre><code>{finding.testCode}</code></pre></details> : <p>{finding.testGuidance || 'No specific test guidance is available for this finding.'}</p>}
      </div>

      <details className="finding-evidence"><summary>Show source evidence ({finding.evidence?.length || 0})</summary>
        {finding.evidence?.length ? finding.evidence.map((evidence, index) => <div className="evidence-block" key={`${evidence.path}-${evidence.side}-${evidence.startLine}-${index}`}><p>{evidence.path} · {evidence.side} lines {evidence.startLine}{evidence.endLine !== evidence.startLine ? `–${evidence.endLine}` : ''}</p><pre><code>{evidence.snippet}</code></pre><small>Source hash: {shortSha(evidence.contentHash)}</small></div>) : <p>No source snippet is attached. Treat this as an unverified hypothesis.</p>}
      </details>

      <div className="finding-actions">
        {finding.conceptId && <button className="concept-toggle" type="button" aria-expanded={conceptState === 'open'} onClick={toggleConcept}>{conceptState === 'loading' ? 'Loading concept…' : conceptState === 'open' ? 'Close concept help' : 'Review this concept'}</button>}
        {canProposePatch ? <button className="patch-toggle" type="button" onClick={() => setPatchConfirmation(true)} disabled={patchState === 'loading'}>{patchState === 'loading' ? 'Generating proposal…' : patchProposal ? 'Generate another proposal' : 'Request suggested code'}</button> : <p className="no-patch-note">A code proposal is unavailable for this finding or snapshot.</p>}
      </div>

      {conceptError && <NoticeInline kind="error">{conceptError}</NoticeInline>}
      {conceptState === 'open' && concept && <section className="concept-panel"><span className="finding-section-label">CONCEPT HELP</span><h3>{concept.title}</h3><p>{concept.explanation}</p><p>{concept.whyItRelates}</p>{concept.example && <pre><code>{concept.example}</code></pre>}</section>}

      {patchConfirmation && <div className="patch-confirmation" role="group" aria-label="Confirm patch proposal"><span className="finding-section-label">CONFIRM PROPOSAL</span><p>Ask the configured provider to draft a replacement using this finding and its pinned source context? Nothing will be applied to GitHub.</p><div><button className="button button-primary" type="button" onClick={generatePatch}>Generate proposal</button><button className="button button-quiet" type="button" onClick={() => setPatchConfirmation(false)}>Cancel</button></div></div>}
      {patchError && <NoticeInline kind="error">{patchError}</NoticeInline>}
      {patchProposal && patchState === 'ready' && <PatchPreview patch={patchProposal} onClose={() => setPatchProposal(null)} />}
    </article>
  );
}

function NoticeInline({ kind, children }) {
  return <div className={`api-notice api-notice-${kind}`} role="alert"><span className="api-notice-mark" aria-hidden="true">!</span><span>{children}</span></div>;
}

export default function FindingsScreen({
  repository, pullRequest, execution, findings, findingsState, findingsError,
  findingsHasMore, onLoadMoreFindings, onBack, onStartNewReview, onRetry, getConcept, createPatch,
}) {
  const status = execution?.status;
  const derivedState = findingsState === 'ready' && status === 'stale' ? 'stale'
    : findingsState === 'ready' && status === 'failed' ? 'error'
      : findingsState === 'ready' && findings.length === 0 && !findingsHasMore ? 'empty'
      : findingsState;
  const partial = status === 'partial';

  return (
    <main className="app-shell findings-shell">
      <nav className="topbar"><a className="brand" href="/" aria-label="Insight home"><span className="brand-mark">i</span><span>insight</span></a><span className="workspace-label">REVIEW FINDINGS</span><button className="button button-quiet" type="button" onClick={onBack}>Back</button></nav>
      <section className="findings-content">
        <p className="section-kicker">LIVE REVIEW</p><h1 className="workspace-title">Potential issues</h1>
        <p className="workspace-description">{repository.fullName} · PR #{pullRequest.number} · {pullRequest.title}</p>

        {derivedState === 'loading' && <ReviewStateMessage state="loading" onBack={onBack} />}
        {derivedState === 'permission' && <ReviewStateMessage state="permission" message={findingsError?.message} onBack={onBack} />}
        {derivedState === 'stale' && <ReviewStateMessage state="stale" message={findingsError?.message || execution?.warnings?.find((warning) => warning.code === 'STALE_REVISION')?.message} onBack={onBack} onRetry={onRetry} />}
        {derivedState === 'error' && <ReviewStateMessage state="error" message={findingsError?.message || execution?.warnings?.[0]?.message} onBack={onBack} onRetry={onRetry} />}

        {execution && findingsState !== 'loading' && <QualitySummary execution={execution} />}
        {partial && ['ready', 'empty'].includes(derivedState) && <div className="api-notice api-notice-warning" role="status"><span className="api-notice-mark" aria-hidden="true">!</span><span>This review is partial. Read its analysis limits and warnings before relying on the results.</span></div>}
        {derivedState === 'empty' && <ReviewStateMessage state="empty" onBack={onBack} />}

        {derivedState === 'ready' && findings.length > 0 && <div className="finding-list">{findings.map((finding) => <FindingCard key={findingId(finding)} finding={finding} execution={execution} getConcept={getConcept} createPatch={createPatch} />)}</div>}
        {derivedState === 'ready' && findingsHasMore && <button className="button button-quiet pagination-button" type="button" onClick={onLoadMoreFindings}>Load more findings</button>}
        {derivedState === 'ready' && <div className="summary-actions findings-footer-actions"><button className="button button-primary" type="button" onClick={onStartNewReview}>Review another pull request</button><button className="button button-quiet" type="button" onClick={onBack}>Back</button></div>}
      </section>
    </main>
  );
}
