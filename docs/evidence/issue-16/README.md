# Issue 16 browser evidence

The baseline browser verifier completed successfully against the production build.

Covered scenarios:

- registry actions remain available at 1024, 1280, and 1440 px;
- registry actions remain available at 1024 px with 125% page zoom;
- a company matrix cell applies a visible section and status filter;
- the single-document deal picker is scoped to the selected company;
- company context shows the expected multi-deal document table.

The generated `result.json` reported `true` for `narrowRegistryActionsAt1024`,
`companyMatrixCellFilter`, `companyScopedDealPicker`, `companyMultiDealTable`, and
`companyLayoutAt1280`.
