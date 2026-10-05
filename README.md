# oc-advisor

Advisor-strategy plugin for opencode: drive with a fast executor model, keep a stronger reviewer one call away.

## Install

```jsonc
{
  "plugins": ["oc-advisor@git+https://github.com/ac5tin/oc-advisor.git"],
}
```

## Usage

```
/advisor
```

Pick a reviewer model. The executor calls `advisor()` on its own when it needs stronger judgment.
