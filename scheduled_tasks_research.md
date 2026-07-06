# Scheduled Tasks Research Summary

## Best Practices
- Use descriptive names, unique IDs, and comments for maintainability.
- Set appropriate permissions and run with least privilege.
- Monitor logs and set up alerts for failures; capture structured errors.
- Test schedules thoroughly; handle edge cases like DST/timezones (always store UTC).
- Use version control for scripts/configs.
- Limit frequency to avoid resource overload; prefer event-driven where possible.
- Document dependencies and error handling/retries; implement backoff.
- For agents: ensure idempotency, use locking (or scheduleId checks) to prevent overlaps.
- Prefer short timeouts for one-offs; persist only true recurring cron entries.

## Cron (Unix/Linux/macOS)
- Format: minute hour day month weekday command
- Powerful expressions via crontab.guru for validation.
- Supports @reboot, environment vars, MAILTO for notifications.
- Tools: crontab -e, anacron for non-24/7 systems.
- Best for servers; integrate with systemd timers for modern Linux.

## Windows Task Scheduler
- GUI + schtasks.exe / PowerShell cmdlets.
- Supports triggers (time, event, logon), actions (exec, email, msg), conditions (idle, power).
- History/logging enabled by default; export/import tasks as XML.
- Run as SYSTEM or specific user; advanced settings for repetition.

## Agent Integration & Modern Platforms
- Python: schedule lib, APScheduler, or cron via subprocess.
- Agents can dynamically create tasks (e.g., via GitHub Actions cron, AWS EventBridge, Vercel Cron).
- Vercel Cron: HTTP GET triggers (vercel-cron UA), supports standard 5-field expressions in UTC only; cannot mix DOM+DOW; add to vercel.json.
- AI agents: poll schedules or use webhooks; ensure sandboxed execution.
- Orchestration: Kubernetes CronJobs, Airflow DAGs, Prefect for complex workflows.
- Monitoring: Prometheus + Grafana, or built-in (systemd, Event Viewer).

Sources: Wikipedia, Microsoft Learn, crontab.guru, Vercel Docs, common dev practices.

## Workspace Notes (Current)
- This agent uses `schedule_task` tool for follow-ups.
- Core: `lib/scheduler.ts` (node-cron, `scheduleFromAgentTool`, `loadAndScheduleAll`, timeout/cron support).
- Exposed to agents: `schedule_task` tool.
- Handles relative ('in Xm'/'in Xs' → timeout), cron strings; stores only valid recurring entries.
- Periodic resync + cleanup of legacy/manual entries. Enforces idempotency via scheduleId.

## Implementation in Workspace
- Uses node-cron for in-process scheduling per agent.
- scheduleFromAgentTool parses natural language + cron, runs via runAgentOnce with schedule metadata.
- No external cron services needed; all managed inside GrokDesk runtime.

## Vercel Cron Jobs
Vercel supports cron jobs via `vercel.json` for serverless scheduled HTTP invocations (UTC only).

Example `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/daily-report",
      "schedule": "0 9 * * *"
    },
    {
      "path": "/api/cron/cleanup",
      "schedule": "0 2 * * 0"
    }
  ]
}
```

API route example (`app/api/cron/daily-report/route.ts`):
```ts
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  // Verify Vercel cron header
  if (request.headers.get('user-agent') !== 'vercel-cron/1.0') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  // Run scheduled task logic
  console.log('Daily report generated');
  return NextResponse.json({ success: true });
}
```

## AWS: EventBridge + Lambda + CloudWatch Alerts
AWS uses EventBridge (formerly CloudWatch Events) for cron scheduling + Lambda.

Terraform example:
```hcl
resource "aws_cloudwatch_event_rule" "daily_cron" {
  name                = "daily-task"
  schedule_expression = "cron(0 9 * * ? *)"  # UTC
}

resource "aws_cloudwatch_event_target" "lambda_target" {
  rule      = aws_cloudwatch_event_rule.daily_cron.name
  target_id = "InvokeLambda"
  arn       = aws_lambda_function.scheduled.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scheduled.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.daily_cron.arn
}
```

CloudWatch Alarm for failures (on Lambda errors):
```hcl
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "scheduled-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    FunctionName = aws_lambda_function.scheduled.function_name
  }
}
```

Lambda handler snippet:
```js
exports.handler = async (event) => {
  console.log('Scheduled task triggered:', event);
  // Add idempotency check + error handling
  return { statusCode: 200, body: 'Success' };
};
```"Research summary reviewed - no changes required." 
"Research task done - scheduler matches documented best practices." 
"Research verification complete - no actions required." 
