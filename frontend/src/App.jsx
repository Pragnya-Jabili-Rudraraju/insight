import { useEffect, useState } from 'react';
import './App.css';
import FindingsScreen from './FindingsScreen';
import { api } from './services/api';

function shortSha(value) {
  return value ? `${value.slice(0, 10)}…` : 'Not available';
}

function explainApiError(error) {
  if (error?.code === 'UNAUTHENTICATED' || error?.code === 'GITHUB_REAUTH_REQUIRED') {
    return 'Connect or reconnect the configured GitHub account to continue.';
  }
  if (error?.code === 'GITHUB_ACCESS_DENIED') {
    return 'This account or GitHub App cannot read this repository. Check the App installation and read permissions.';
  }
  if (error?.code === 'GITHUB_NOT_CONFIGURED') {
    return 'GitHub sign-in is not configured on the backend yet.';
  }
  if (error?.code === 'STALE_REVISION' || error?.code === 'STALE_PATCH_REVISION' || error?.code === 'STALE_PATCH_FILE') {
    return 'The pull request or source file changed. Reload the current data before continuing.';
  }
  if (error?.code === 'REPOSITORY_CURSOR_STALE') {
    return 'The available GitHub installations changed. Restart repository pagination.';
  }
  if (error?.code === 'AI_NOT_CONFIGURED') {
    return 'Patch proposals need a supported LLM provider configured on the backend. Reviews can still use deterministic analysis.';
  }
  if (error?.code === 'PATCH_CONTENT_EXPIRED') {
    return 'This proposal’s source content expired under the repository retention policy.';
  }
  return error?.message || 'Something went wrong. Try again.';
}

function Notice({ kind = 'info', title, children, onRetry }) {
  return (
    <div className={`api-notice api-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="api-notice-mark" aria-hidden="true">{kind === 'success' ? '✓' : '!'}</span>
      <div className="api-notice-copy">
        {title && <strong>{title}</strong>}
        <span>{children}</span>
        {onRetry && <button className="inline-action" type="button" onClick={onRetry}>Try again</button>}
      </div>
    </div>
  );
}

function AccountActions({ session, onLogout, onDisconnect, busy }) {
  if (!session?.authenticated) return null;
  return (
    <div className="account-actions">
      <span className="account-name">@{session.githubUser?.login || 'GitHub account'}</span>
      <button className="inline-action" type="button" onClick={onLogout} disabled={busy}>Sign out</button>
      <button className="inline-action" type="button" onClick={onDisconnect} disabled={busy}>Disconnect</button>
    </div>
  );
}

function HomeScreen({ session, sessionState, sessionError, flash, onOpenWorkspace, onLogout, onDisconnect, busy }) {
  const connected = session?.authenticated && session.githubConnection === 'connected';
  return (
    <main className="app-shell">
      <nav className="topbar">
        <a className="brand" href="/" aria-label="Insight home">
          <span className="brand-mark">i</span><span>insight</span>
        </a>
        <div className="topbar-links">
          <a href="#approach">How it works</a><a href="#principles">Our approach</a>
        </div>
        <div className="topbar-account">
          {connected ? (
            <AccountActions session={session} onLogout={onLogout} onDisconnect={onDisconnect} busy={busy} />
          ) : (
            <a className="button button-quiet" href={api.githubSignInUrl()}>
              {session?.authenticated ? 'Reconnect GitHub' : 'Sign in with GitHub'}
            </a>
          )}
          <button className="button button-quiet" type="button" onClick={onOpenWorkspace}>Open workspace</button>
        </div>
      </nav>

      {(flash || sessionError) && (
        <Notice kind={sessionError ? 'error' : 'success'} title={sessionError ? 'Session status' : 'GitHub connection'}>
          {sessionError ? explainApiError(sessionError) : flash}
        </Notice>
      )}
      {sessionState === 'loading' && <p className="prototype-note">Checking the current GitHub session…</p>}

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="status-dot" />AI CODE REVIEW &amp; REPOSITORY RISK INTELLIGENCE</div>
          <h1>See beyond<br />the <span>code.</span></h1>
          <p className="hero-description">Pull requests tell you what changed. Insight helps you understand what those changes could affect—and where to look closer.</p>
          <div className="hero-actions">
            {connected ? (
              <button className="button button-primary" type="button" onClick={onOpenWorkspace}>Open review workspace <span aria-hidden="true">↗</span></button>
            ) : (
              <a className="button button-primary" href={api.githubSignInUrl()}>Connect GitHub to begin <span aria-hidden="true">↗</span></a>
            )}
            <a className="text-link" href="#principles">What we value <span aria-hidden="true">↓</span></a>
          </div>
          <p className="prototype-note">
            {connected ? `Connected to GitHub as @${session.githubUser?.login}. Reviews remain read-only.` : 'Single-account GitHub App · Review data appears only after a live review runs.'}
          </p>
        </div>

        <div className="flow-visual" aria-label="Illustration of the review flow">
          <div className="flow-orbit orbit-one" /><div className="flow-orbit orbit-two" />
          <div className="flow-heading"><span className="flow-kicker">A CLEARER REVIEW</span><span className="flow-caption">From change to understanding</span></div>
          <div className="flow-step step-change"><span className="step-icon change-icon" aria-hidden="true">⌘</span><span className="step-copy"><strong>Code change</strong><small>What was updated</small></span><span className="step-marker">01</span></div>
          <div className="flow-connector connector-one"><span /></div>
          <div className="flow-step step-impact"><span className="step-icon impact-icon" aria-hidden="true">⌁</span><span className="step-copy"><strong>Potential impact</strong><small>What may be affected</small></span><span className="step-marker">02</span></div>
          <div className="flow-connector connector-two"><span /></div>
          <div className="flow-step step-evidence"><span className="step-icon evidence-icon" aria-hidden="true">✓</span><span className="step-copy"><strong>Review evidence</strong><small>What supports a finding</small></span><span className="step-marker">03</span></div>
          <div className="flow-footnote"><span className="footnote-dot" />A guide for the reviewer—not an automatic code change</div>
        </div>
      </section>

      <section className="approach-section" id="approach">
        <div className="section-heading"><span className="section-kicker">THE REVIEW FLOW</span><h2>Understand the change before you ship it.</h2></div>
        <div className="approach-grid">
          <article className="approach-card"><span className="card-number">01</span><h3>See what changed</h3><p>Start with the pull request and the exact files it touches.</p></article>
          <article className="approach-card"><span className="card-number">02</span><h3>Follow the impact</h3><p>Trace how a change could affect related parts of the code.</p></article>
          <article className="approach-card"><span className="card-number">03</span><h3>Check the evidence</h3><p>Review the source and reasoning behind each suggestion.</p></article>
        </div>
      </section>

      <section className="principles-section" id="principles">
        <div><span className="section-kicker">BUILT FOR DEVELOPERS</span><h2>Useful context. You stay in control.</h2></div>
        <div className="principle-list">
          <div className="principle"><span className="principle-check">✓</span><span>Read-only by design</span></div>
          <div className="principle"><span className="principle-check">✓</span><span>Evidence before confidence</span></div>
          <div className="principle"><span className="principle-check">✓</span><span>Clear limits, no false certainty</span></div>
        </div>
      </section>
      <footer className="page-footer"><span>INSIGHT <span className="footer-separator">/</span> SEE BEYOND THE CODE</span><span>Live review data · Read-only GitHub access</span></footer>
    </main>
  );
}

function WorkspaceScreen({
  session, repositories, repositoryState, repositoryError, selectedRepository,
  onRepositoryChange, onLoadMoreRepositories, pullRequests, pullRequestState,
  pullRequestError, selectedPullRequest, onPullRequestSelect, onContinue,
  onOpenHistory, onBackHome, onLogout, onDisconnect, busy,
}) {
  const githubReady = session?.authenticated && session.githubConnection === 'connected';
  return (
    <main className="app-shell workspace-shell">
      <nav className="topbar">
        <a className="brand" href="/" aria-label="Insight home"><span className="brand-mark">i</span><span>insight</span></a>
        <span className="workspace-label">REVIEW WORKSPACE</span>
        <div className="topbar-account">
          {githubReady ? <AccountActions session={session} onLogout={onLogout} onDisconnect={onDisconnect} busy={busy} /> : <a className="button button-quiet" href={api.githubSignInUrl()}>Connect GitHub</a>}
          <button className="button button-quiet" type="button" onClick={onBackHome}>Back home</button>
        </div>
      </nav>

      <section className="workspace-content">
        <p className="section-kicker">START A REVIEW</p>
        <h1 className="workspace-title">Choose a pull request.</h1>
        <p className="workspace-description">Choose a repository installed for your GitHub account, then select an open pull request. Insight requests read access only.</p>

        {!githubReady && (
          <Notice kind="warning" title={session?.authenticated ? 'Reconnect GitHub' : 'GitHub sign-in required'}>
            {session?.authenticated ? 'The saved GitHub authorization needs to be renewed.' : 'Sign in with the configured GitHub account to load repositories.'}
          </Notice>
        )}
        {repositoryError && <Notice kind="error" title="Could not load repositories">{explainApiError(repositoryError)}</Notice>}
        {repositoryState.incomplete && <Notice kind="warning" title="Repository list is incomplete">{repositoryState.incompleteReasons?.join(', ') || 'GitHub reached a configured pagination limit.'} {repositoryState.nextCursor ? 'Use Load more to continue.' : 'The remaining installations are beyond the configured page limit.'}</Notice>}

        <label className="field-label" htmlFor="repository">Repository</label>
        <select className="select-control" id="repository" value={selectedRepository?.id || ''} onChange={(event) => onRepositoryChange(event.target.value)} disabled={!githubReady || repositoryState.status === 'loading'}>
          <option value="">{repositoryState.status === 'loading' && repositories.length === 0 ? 'Loading repositories…' : 'Choose a repository'}</option>
          {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}{repository.selected ? ' · selected' : ''}</option>)}
        </select>
        {repositoryState.status === 'loading' && repositories.length === 0 && <p className="loading-copy">Loading authorized repositories…</p>}
        {repositoryState.status === 'empty' && <div className="summary-empty-state"><span className="summary-empty-icon" aria-hidden="true">⌕</span><div><h2>No repositories available</h2><p>Install the Insight GitHub App on a repository, then refresh this list.</p></div></div>}
        {repositoryState.nextCursor && <button className="button button-quiet pagination-button" type="button" onClick={onLoadMoreRepositories} disabled={repositoryState.status === 'loading'}>{repositoryState.status === 'loading' ? 'Loading…' : 'Load more repositories'}</button>}

        {selectedRepository && (
          <>
            <div className="repository-description">{selectedRepository.isPrivate ? 'Private' : 'Public'} repository · {selectedRepository.accessStatus || 'available'} access status</div>
            {selectedRepository.accessStatus === 'reauthorization_required' && <Notice kind="warning" title="GitHub authorization needs renewal">Reconnect the GitHub account before loading pull requests.</Notice>}
            <fieldset className="pull-request-fieldset">
              <legend className="field-label">Open pull requests</legend>
              {pullRequestError && <Notice kind="error" title="Could not load pull requests">{explainApiError(pullRequestError)}</Notice>}
              {pullRequestState.incomplete && <Notice kind="warning" title="Pull request list is incomplete">The GitHub page limit was reached. The final page is not being presented as the complete list.</Notice>}
              {pullRequestState.status === 'loading' && <p className="loading-copy">Loading pull requests…</p>}
              {pullRequestState.status === 'empty' && <div className="summary-empty-state"><span className="summary-empty-icon" aria-hidden="true">⌕</span><div><h2>No open pull requests</h2><p>This repository currently has no open pull requests available to this account.</p></div></div>}
              <div className="pull-request-list">
                {pullRequests.map((pullRequest) => {
                  const isSelected = selectedPullRequest?.number === pullRequest.number;
                  return (
                    <button className={`pull-request-option${isSelected ? ' is-selected' : ''}`} key={pullRequest.number} type="button" aria-pressed={isSelected} onClick={() => onPullRequestSelect(pullRequest)}>
                      <span className="pr-option-main"><strong>{pullRequest.title}</strong><small>#{pullRequest.number} · {pullRequest.author} · {pullRequest.state}</small></span>
                      <span className="pr-file-count">{new Date(pullRequest.updatedAt).toLocaleDateString()}</span>
                    </button>
                  );
                })}
              </div>
              {pullRequestState.nextCursor && <button className="button button-quiet pagination-button" type="button" onClick={pullRequestState.onLoadMore} disabled={pullRequestState.status === 'loading'}>Load more pull requests</button>}
            </fieldset>
          </>
        )}

        <div className="workspace-actions">
          <button className="button button-primary" type="button" disabled={!selectedPullRequest || busy} onClick={onContinue}>Review selected PR <span aria-hidden="true">↗</span></button>
          {selectedRepository?.selected && selectedRepository.accessStatus === 'active' && <button className="button button-quiet" type="button" onClick={onOpenHistory}>Repository history</button>}
        </div>
        {!selectedPullRequest && <p className="selection-hint">Choose a repository and pull request to continue.</p>}
      </section>
    </main>
  );
}

function ReviewSummaryScreen({ repository, pullRequest, onBack, onStartReview, reviewStarting, error }) {
  return (
    <main className="app-shell workspace-shell">
      <nav className="topbar"><a className="brand" href="/" aria-label="Insight home"><span className="brand-mark">i</span><span>insight</span></a><span className="workspace-label">REVIEW SUMMARY</span><button className="button button-quiet" type="button" onClick={onBack}>Back to selection</button></nav>
      <section className="summary-content">
        <p className="section-kicker">LIVE REVIEW</p>
        <h1 className="workspace-title">Review summary</h1>
        <p className="workspace-description">Confirm the pull request and pinned revision before starting analysis. A new execution is created each time you run a review.</p>
        <article className="selected-pr-card">
          <div className="selected-pr-heading"><div><p className="selected-repo-name">{repository.fullName}</p><h2>{pullRequest.title}</h2></div><span className="pr-badge">PR #{pullRequest.number}</span></div>
          <div className="selected-pr-details">
            <div><span className="detail-label">SOURCE BRANCH</span><span className="detail-value">{pullRequest.head?.ref || 'Not available'}</span></div>
            <div><span className="detail-label">TARGET BRANCH</span><span className="detail-value">{pullRequest.base?.ref || 'Not available'}</span></div>
            <div><span className="detail-label">CURRENT STATE</span><span className="detail-value">{pullRequest.state}</span></div>
          </div>
          <details className="patch-revision-details"><summary>Revision details</summary><p>Base: <code>{pullRequest.base?.sha || 'Not available'}</code><br />Head: <code>{pullRequest.head?.sha || 'Not available'}</code></p></details>
        </article>
        <div className="summary-empty-state"><span className="summary-empty-icon" aria-hidden="true">✦</span><div><h2>No review has run for this selection</h2><p>Starting the review fetches the pull request snapshot and runs the configured deterministic analysis and optional AI review. Insight will not write to GitHub.</p></div></div>
        {error && <Notice kind="error" title="Review could not start">{explainApiError(error)}</Notice>}
        <div className="summary-actions"><button className="button button-primary" type="button" onClick={onStartReview} disabled={reviewStarting}>{reviewStarting ? 'Starting review…' : 'Start live review'}<span aria-hidden="true">↗</span></button><button className="button button-quiet" type="button" onClick={onBack}>Change selection</button></div>
      </section>
    </main>
  );
}

function HistoryScreen({ repository, history, state, error, onBack, onLoadMore, onOpenReview }) {
  return (
    <main className="app-shell findings-shell">
      <nav className="topbar"><a className="brand" href="/" aria-label="Insight home"><span className="brand-mark">i</span><span>insight</span></a><span className="workspace-label">REPOSITORY HISTORY</span><button className="button button-quiet" type="button" onClick={onBack}>Back to workspace</button></nav>
      <section className="findings-content">
        <p className="section-kicker">DESCRIPTIVE RISK HISTORY</p><h1 className="workspace-title">{repository.fullName}</h1>
        <p className="workspace-description">Past review executions and recurring findings for this repository. These records describe reviewed changes; they do not predict future risk.</p>
        {error && <Notice kind="error" title="History could not load">{explainApiError(error)}</Notice>}
        {history?.coverage && (
          <section className="review-quality" aria-label="History coverage">
            <div className="quality-heading"><div><span className="section-kicker">HISTORY COVERAGE</span><h2>{history.coverage.reviewedExecutionsAvailable} reviewed executions available</h2></div></div>
            <p className="quality-description">{history.coverage.reviewedPullRequests} pull requests represented in the analyzed history window · {history.coverage.changedFilesAnalyzed} changed files analyzed.</p>
            {history.coverage.aggregationIncomplete && <Notice kind="warning" title="History aggregation is incomplete">Only {history.coverage.aggregationRecordLimit} records per aggregation source are analyzed. Counts below use the displayed coverage window.</Notice>}
          </section>
        )}
        {state === 'loading' && <p className="loading-copy">Loading repository history…</p>}
        {state === 'empty' && <div className="summary-empty-state"><span className="summary-empty-icon" aria-hidden="true">⌕</span><div><h2>No review history yet</h2><p>Run a review to begin building revision-bound history for this repository.</p></div></div>}
        {history?.executions?.length > 0 && <div className="finding-list">
          {history.executions.map((execution) => (
            <article className="history-execution-card" key={execution._id}>
              <div className="finding-card-heading"><div className="finding-severity-group"><span className={`execution-status status-${execution.status}`}>{execution.status}</span><span className="finding-category">PR #{execution.pullRequestNumber}</span></div><span className="finding-location">{new Date(execution.createdAt).toLocaleString()}</span></div>
              <p className="history-revision">Head {shortSha(execution.headSha)} · {execution.qualitySummary?.totalFindings || 0} accepted findings</p>
              {execution.warnings?.length > 0 && <p className="test-code-note">{execution.warnings.length} review warning(s)</p>}
              <button className="patch-toggle" type="button" onClick={() => onOpenReview(execution)}>Open this review</button>
            </article>
          ))}
        </div>}
        {history?.recurrence?.length > 0 && (
          <section className="review-quality">
            <div className="quality-heading"><div><span className="section-kicker">RECURRING FINDINGS</span><h2>Observed across prior reviews</h2></div></div>
            {history.recurrenceCoverage && <p className="quality-description">{history.recurrenceCoverage.occurrencesAnalyzed} of {history.recurrenceCoverage.occurrencesAvailable} occurrences analyzed; {history.recurrenceCoverage.fingerprintsReturned} fingerprint groups shown.</p>}
            {history.recurrenceCoverage?.complete === false && <p className="test-code-note">This recurrence list is incomplete under the configured aggregation limits.</p>}
            <div className="recurrence-list">{history.recurrence.map((item) => <div className="recurrence-row" key={`${item.fingerprintVersion}-${item.fingerprint}-${item.matchKind}`}><strong>{item.category}</strong><span>{item.matchKind === 'confirmed' ? 'Confirmed rule match' : 'Possible AI-assisted match'}</span><small>{item.count} occurrences across {item.comparableExecutionCount} executions</small></div>)}</div>
          </section>
        )}
        {history?.hasMore && <button className="button button-quiet pagination-button" type="button" onClick={onLoadMore} disabled={state === 'loading'}>Load more history</button>}
      </section>
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState('home');
  const [session, setSession] = useState(null);
  const [sessionState, setSessionState] = useState('loading');
  const [sessionError, setSessionError] = useState(null);
  const [flash, setFlash] = useState(() => {
    const callbackStatus = new URLSearchParams(window.location.search).get('github');
    if (callbackStatus === 'connected') return 'GitHub connected. Repository access is read-only.';
    if (callbackStatus === 'cancelled') return 'GitHub sign-in was cancelled.';
    return '';
  });
  const [busy, setBusy] = useState(false);
  const [repositories, setRepositories] = useState([]);
  const [repositoryState, setRepositoryState] = useState({ status: 'idle', nextCursor: null, incomplete: false, incompleteReasons: [] });
  const [repositoryError, setRepositoryError] = useState(null);
  const [selectedRepository, setSelectedRepository] = useState(null);
  const [pullRequests, setPullRequests] = useState([]);
  const [pullRequestState, setPullRequestState] = useState({ status: 'idle', nextCursor: null, incomplete: false });
  const [pullRequestError, setPullRequestError] = useState(null);
  const [selectedPullRequest, setSelectedPullRequest] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [reviewStarting, setReviewStarting] = useState(false);
  const [execution, setExecution] = useState(null);
  const [findings, setFindings] = useState([]);
  const [findingsState, setFindingsState] = useState('idle');
  const [findingsError, setFindingsError] = useState(null);
  const [findingsCursor, setFindingsCursor] = useState(null);
  const [findingsHasMore, setFindingsHasMore] = useState(false);
  const [history, setHistory] = useState(null);
  const [historyState, setHistoryState] = useState('idle');
  const [historyError, setHistoryError] = useState(null);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [findingsReturnTo, setFindingsReturnTo] = useState('summary');

  useEffect(() => {
    let active = true;
    const callbackStatus = new URLSearchParams(window.location.search).get('github');
    if (callbackStatus) window.history.replaceState({}, '', window.location.pathname);
    api.getSession().then((value) => {
      if (!active) return;
      setSession(value);
      setSessionState(value.authenticated ? 'authenticated' : 'anonymous');
    }).catch((error) => {
      if (!active) return;
      setSessionError(error);
      setSessionState('error');
    });
    return () => { active = false; };
  }, []);

  async function loadRepositories(cursor = null, append = false) {
    setRepositoryError(null);
    setRepositoryState((previous) => ({ ...previous, status: 'loading' }));
    try {
      const response = await api.listRepositories(cursor);
      setRepositories((previous) => append ? [...previous, ...response.repositories] : response.repositories);
      setRepositoryState({
        status: response.repositories.length ? 'ready' : 'empty',
        nextCursor: response.nextCursor,
        incomplete: Boolean(response.incomplete),
        incompleteReasons: response.incompleteReasons || [],
      });
    } catch (error) {
      setRepositoryError(error);
      setRepositoryState((previous) => ({ ...previous, status: 'error' }));
    }
  }

  async function openWorkspace() {
    setScreen('workspace');
    let currentSession = session;
    if (!currentSession && sessionState === 'loading') {
      try {
        currentSession = await api.getSession();
        setSession(currentSession);
        setSessionState(currentSession.authenticated ? 'authenticated' : 'anonymous');
      } catch (error) {
        setSessionError(error);
        setSessionState('error');
      }
    }
    if (currentSession?.authenticated && currentSession.githubConnection === 'connected' && repositoryState.status === 'idle') {
      loadRepositories();
    }
  }

  async function handleRepositoryChange(repositoryId) {
    setSelectedPullRequest(null);
    setPullRequests([]);
    setPullRequestError(null);
    setPullRequestState({ status: repositoryId ? 'loading' : 'idle', nextCursor: null, incomplete: false });
    if (!repositoryId) { setSelectedRepository(null); return; }
    const candidate = repositories.find((repository) => repository.id === repositoryId);
    if (!candidate) return;
    setSelectedRepository(candidate);
    if (session?.githubConnection !== 'connected') {
      setPullRequestError({ code: 'GITHUB_REAUTH_REQUIRED', message: 'Reconnect GitHub to continue.' });
      setPullRequestState({ status: 'error', nextCursor: null, incomplete: false });
      return;
    }
    try {
      let selected = candidate;
      if (!candidate.selected || candidate.accessStatus !== 'active') {
        await api.selectRepository(candidate.id, candidate.installationId, false);
        selected = { ...candidate, selected: true, accessStatus: 'active' };
        setRepositories((previous) => previous.map((repository) => repository.id === candidate.id ? selected : repository));
      }
      setSelectedRepository(selected);
      await loadPullRequests(selected, '1', false);
    } catch (error) {
      setPullRequestError(error);
      setPullRequestState({ status: 'error', nextCursor: null, incomplete: false });
    }
  }

  async function loadPullRequests(repository, cursor = '1', append = false) {
    setPullRequestError(null);
    setPullRequestState((previous) => ({ ...previous, status: 'loading' }));
    try {
      const response = await api.listPullRequests(repository.id, cursor);
      setPullRequests((previous) => append ? [...previous, ...response.pullRequests] : response.pullRequests);
      setPullRequestState({
        status: response.pullRequests.length ? 'ready' : 'empty',
        nextCursor: response.nextCursor,
        incomplete: Boolean(response.incomplete),
      });
    } catch (error) {
      setPullRequestError(error);
      setPullRequestState((previous) => ({ ...previous, status: 'error' }));
    }
  }

  async function handlePullRequestSelect(pullRequest) {
    setPullRequestError(null);
    setSelectedPullRequest(null);
    setPullRequestState((previous) => ({ ...previous, status: 'loading' }));
    try {
      const details = await api.getPullRequest(selectedRepository.id, pullRequest.number);
      setSelectedPullRequest({ ...pullRequest, ...details });
      setPullRequestState((previous) => ({ ...previous, status: pullRequests.length ? 'ready' : 'empty' }));
    } catch (error) {
      setPullRequestError(error);
      setPullRequestState((previous) => ({ ...previous, status: 'error' }));
    }
  }

  async function startReview() {
    if (!selectedRepository || !selectedPullRequest) return;
    setSummaryError(null);
    setReviewStarting(true);
    setExecution(null);
    setFindings([]);
    setFindingsState('loading');
    setFindingsError(null);
    setFindingsHasMore(false);
    setFindingsCursor(null);
    setFindingsReturnTo('summary');
    setScreen('findings');
    try {
      const response = await api.createReview(selectedRepository.id, selectedPullRequest.number);
      setExecution(response.execution);
      await loadFindings(response.execution._id || response.execution.id, false);
    } catch (error) {
      setFindingsError(error);
      setFindingsState(error?.status === 409 ? 'stale' : error?.status === 401 || error?.status === 403 ? 'permission' : 'error');
    } finally {
      setReviewStarting(false);
    }
  }

  async function loadFindings(executionId, append = false, cursor = null) {
    setFindingsError(null);
    if (!append) setFindingsState('loading');
    try {
      const response = await api.listFindings(executionId, cursor);
      setFindings((previous) => append ? [...previous, ...response.findings] : response.findings);
      setFindingsCursor(response.nextCursor);
      setFindingsHasMore(Boolean(response.hasMore));
      setFindingsState('ready');
    } catch (error) {
      setFindingsError(error);
      setFindingsState(error?.status === 409 ? 'stale' : error?.status === 401 || error?.status === 403 ? 'permission' : 'error');
    }
  }

  async function loadMoreFindings() {
    if (execution && findingsCursor) await loadFindings(execution._id || execution.id, true, findingsCursor);
  }

  async function openHistory() {
    if (!selectedRepository) return;
    setHistory(null);
    setHistoryCursor(null);
    setHistoryError(null);
    setHistoryState('loading');
    setScreen('history');
    try {
      const response = await api.getHistory(selectedRepository.id);
      setHistory(response);
      setHistoryCursor(response.nextCursor);
      setHistoryState(response.executions.length ? 'ready' : 'empty');
    } catch (error) {
      setHistoryError(error);
      setHistoryState('error');
    }
  }

  async function loadMoreHistory() {
    if (!selectedRepository || !historyCursor) return;
    setHistoryState('loading');
    try {
      const response = await api.getHistory(selectedRepository.id, historyCursor);
      setHistory((previous) => ({ ...response, executions: [...(previous?.executions || []), ...response.executions] }));
      setHistoryCursor(response.nextCursor);
      setHistoryState('ready');
    } catch (error) { setHistoryError(error); setHistoryState('error'); }
  }

  async function openHistoricalReview(historyExecution) {
    setExecution(historyExecution);
    setSelectedPullRequest({ number: historyExecution.pullRequestNumber, title: `PR #${historyExecution.pullRequestNumber} · historical snapshot`, state: 'historical', base: { sha: historyExecution.baseSha }, head: { sha: historyExecution.headSha } });
    setFindings([]);
    setFindingsState('loading');
    setFindingsReturnTo('history');
    setScreen('findings');
    try {
      const [reviewResponse, findingsResponse] = await Promise.all([
        api.getReview(historyExecution._id), api.listFindings(historyExecution._id),
      ]);
      setExecution(reviewResponse.execution);
      setFindings(findingsResponse.findings);
      setFindingsCursor(findingsResponse.nextCursor);
      setFindingsHasMore(Boolean(findingsResponse.hasMore));
      setFindingsState('ready');
    } catch (error) {
      setFindingsError(error);
      setFindingsState(error?.status === 409 ? 'stale' : error?.status === 401 || error?.status === 403 ? 'permission' : 'error');
    }
  }

  async function finishSession(disconnect = false) {
    setBusy(true);
    try {
      if (disconnect) await api.disconnectGitHub();
      else await api.logout();
      setSession({ authenticated: false });
      setSessionState('anonymous');
      setRepositories([]);
      setSelectedRepository(null);
      setSelectedPullRequest(null);
      setExecution(null);
      setFindings([]);
      setHistory(null);
      setScreen('home');
      setFlash(disconnect ? 'GitHub disconnected.' : 'You have signed out.');
    } catch (error) { setSessionError(error); }
    finally { setBusy(false); }
  }

  if (screen === 'findings' && selectedRepository && selectedPullRequest) {
    return <FindingsScreen
      repository={selectedRepository}
      pullRequest={selectedPullRequest}
      execution={execution}
      findings={findings}
      findingsState={findingsState}
      findingsError={findingsError}
      findingsHasMore={findingsHasMore}
      onLoadMoreFindings={loadMoreFindings}
      onBack={() => setScreen(findingsReturnTo)}
      onStartNewReview={() => setScreen('workspace')}
      onRetry={startReview}
      getConcept={(findingId) => api.getConcept(execution?._id || execution?.id, findingId)}
      createPatch={(findingId, headSha, fileHash) => api.createPatchProposal(execution?._id || execution?.id, findingId, headSha, fileHash)}
    />;
  }

  if (screen === 'summary' && selectedRepository && selectedPullRequest) {
    return <ReviewSummaryScreen repository={selectedRepository} pullRequest={selectedPullRequest} onBack={() => setScreen('workspace')} onStartReview={startReview} reviewStarting={reviewStarting} error={summaryError} />;
  }

  if (screen === 'history' && selectedRepository) {
    return <HistoryScreen repository={selectedRepository} history={history} state={historyState} error={historyError} onBack={() => setScreen('workspace')} onLoadMore={loadMoreHistory} onOpenReview={openHistoricalReview} />;
  }

  if (screen === 'workspace') {
    return <WorkspaceScreen
      session={session}
      repositories={repositories}
      repositoryState={repositoryState}
      repositoryError={repositoryError}
      selectedRepository={selectedRepository}
      onRepositoryChange={handleRepositoryChange}
      onLoadMoreRepositories={() => loadRepositories(repositoryState.nextCursor, true)}
      pullRequests={pullRequests}
      pullRequestState={{ ...pullRequestState, onLoadMore: () => loadPullRequests(selectedRepository, pullRequestState.nextCursor, true) }}
      pullRequestError={pullRequestError}
      selectedPullRequest={selectedPullRequest}
      onPullRequestSelect={handlePullRequestSelect}
      onContinue={() => setScreen('summary')}
      onOpenHistory={openHistory}
      onBackHome={() => setScreen('home')}
      onLogout={() => finishSession(false)}
      onDisconnect={() => finishSession(true)}
      busy={busy}
    />;
  }

  return <HomeScreen session={session} sessionState={sessionState} sessionError={sessionError} flash={flash} onOpenWorkspace={openWorkspace} onLogout={() => finishSession(false)} onDisconnect={() => finishSession(true)} busy={busy} />;
}

export default App;
