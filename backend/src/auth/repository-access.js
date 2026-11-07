const SelectedRepository = require("../models/selected-repository.model");

function createRequireSelectedRepository() {
  return async (req, res, next) => {
    const repositoryId = String(req.params.repositoryId || "");
    if (!/^\d+$/.test(repositoryId)) {
      return res.status(400).json({ error: { code: "INVALID_REPOSITORY_ID", message: "Repository ID is invalid.", retryable: false, requestId: req.requestId } });
    }
    try {
      const repository = await SelectedRepository.findOne({ githubRepositoryId: repositoryId, accessStatus: "active" });
      if (!repository) {
        return res.status(404).json({ error: { code: "REPOSITORY_NOT_SELECTED", message: "This repository is not selected or is no longer accessible.", retryable: false, requestId: req.requestId } });
      }
      req.selectedRepository = repository;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createRequireSelectedRepository };
