# Metrics

Midden can expose [Prometheus](https://prometheus.io) metrics, for dashboards and alerts on how the server and the team's tasks are doing. They're off by default.

Nothing is ever sent out of Midden. There's no phone-home and no usage reporting: Prometheus has to come and ask, with a token you gave it.

Team leads don't need any of this. The **Insights** page, under **Tasks**, shows open work, throughput, cycle time and burndowns to anyone signed in. Metrics are for whoever runs the server.

## Turning them on

1. Set `MIDDEN_METRICS=token` and restart. In the Helm chart, set `metrics.enabled` (see [Running on Kubernetes](kubernetes.md#metrics)).
2. Sign in as an admin, open **API tokens**, and create a **read-only** token for Prometheus, ideally with an expiry. Only an admin's token can read metrics, because they describe the whole server.
3. Give Prometheus the token:

```yaml
scrape_configs:
  - job_name: midden
    metrics_path: /api/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/midden-token
    static_configs:
      - targets: ['midden.corp.example']
```

To check it works:

```bash
curl -H "Authorization: Bearer $MIDDEN_TOKEN" https://midden.corp.example/api/metrics
```

With metrics off, `/api/metrics` answers 404. Without a token, or with a browser session, it answers 401, and with someone else's token it answers 403.

## What is exposed

Labels never name a person, a case or a task. The most specific label is a team's name, so the output is safe to keep in a monitoring system that more people can see than can see your cases. Counts include tasks linked to restricted cases.

Counters marked _since start_ reset when the server restarts, which Prometheus's `rate()` and `increase()` allow for.

### Tasks

| Metric                            | Type      | What it counts                                                                                                                      |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `midden_tasks_open`               | gauge     | Open tasks (not done, cancelled or archived), by `category` and `team`. A task counts toward its queue's team, else its run's team. |
| `midden_tasks_created_total`      | counter   | Tasks created, since start                                                                                                          |
| `midden_tasks_completed_total`    | counter   | Tasks that reached a done status, by `team`, since start                                                                            |
| `midden_tasks_reopened_total`     | counter   | Tasks moved from done or cancelled back to an open status, since start                                                              |
| `midden_task_cycle_seconds`       | histogram | Time from a task first going in progress to it being done, from one hour to a month                                                 |
| `midden_notifications_total`      | counter   | In-app notifications delivered, by `kind`, since start                                                                              |
| `midden_webhook_deliveries_total` | counter   | Webhook delivery attempts, by `result`: `ok`, `retry` or `failed` (gave up), since start                                            |
| `midden_webhook_queue_depth`      | gauge     | Webhook messages waiting to be sent or retried                                                                                      |

### Server

| Metric                                                                | Type      | What it counts                                                                                              |
| --------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `midden_build_info`                                                   | gauge     | Always 1, with the `version` and `node` labels                                                              |
| `midden_http_requests_total`                                          | counter   | API requests, by `method`, `route` (the route template, such as `/api/tasks/:id`) and `status`, since start |
| `midden_http_request_duration_seconds`                                | histogram | API request time, by `method` and `route`                                                                   |
| `midden_ws_connections`                                               | gauge     | Open browser sockets                                                                                        |
| `midden_ops_total`                                                    | counter   | Changes in the logs, by `stream`: `tasks` or `cases`. Deleting a case lowers it.                            |
| `midden_cases`                                                        | gauge     | Cases, by `state`: `open` or `archived`                                                                     |
| `midden_users`                                                        | gauge     | Accounts that aren't disabled                                                                               |
| `midden_db_size_bytes`                                                | gauge     | The SQLite database, not counting its write-ahead log                                                       |
| `midden_event_loop_delay_p50_seconds`, `_p99_seconds`, `_max_seconds` | gauge     | Event loop delay since the last scrape. If p99 stays above about 0.1, the server is too busy.               |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes`             | gauge     | Memory                                                                                                      |
| `process_cpu_seconds_total`                                           | counter   | CPU time                                                                                                    |
| `process_start_time_seconds`                                          | gauge     | When the server started                                                                                     |

Requests to the WebSocket endpoint aren't timed, because a socket stays open for as long as someone has Midden open.

## Example queries

Tasks finished per day, by team:

```promql
sum by (team) (increase(midden_tasks_completed_total[1d]))
```

Median cycle time over the last week, in hours:

```promql
histogram_quantile(0.5, sum by (le) (rate(midden_task_cycle_seconds_bucket[7d]))) / 3600
```

Blocked work per team:

```promql
sum by (team) (midden_tasks_open{category="blocked"})
```

Slow API routes:

```promql
histogram_quantile(0.95, sum by (le, route) (rate(midden_http_request_duration_seconds_bucket[5m])))
```

## Suggested alerts

```yaml
groups:
  - name: midden
    rules:
      - alert: MiddenWebhooksFailing
        expr: increase(midden_webhook_deliveries_total{result="failed"}[1h]) > 0
        annotations:
          summary: Midden gave up sending a chat message. Check the webhook's delivery log on the Teams page.
      - alert: MiddenWebhookBacklog
        expr: midden_webhook_queue_depth > 50
        for: 30m
      - alert: MiddenEventLoopSlow
        expr: midden_event_loop_delay_p99_seconds > 0.25
        for: 10m
```

## Logs

Logs are JSON on stdout. Each change to tasks writes one line with the message `task change`, giving the change's sequence number, op type, the actor's id, the API token's name if one was used, and how many tasks it touched. Task titles and comments are left out, because they can say more than a log should.
