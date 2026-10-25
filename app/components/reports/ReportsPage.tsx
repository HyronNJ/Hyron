import { useState } from "react";
import { ArrowUpRight, FileText, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import Modal from "@/components/Modal";
import { contactFor } from "@/lib/contacts";
import type { Report } from "@/lib/types";
import type { WorkspaceController } from "@/hooks/use-workspace";

const statuses = { draft_ready: "Draft ready", marked_sent: "Marked sent", resolved: "Resolved" };
type Props = { workspace: WorkspaceController; onCreate: () => void };

export function ReportEditor({
  report,
  workspace,
  onClose,
}: {
  report: Report;
  workspace: WorkspaceController;
  onClose: () => void;
}) {
  const [to, setTo] = useState(report.recipient ?? "");
  const [subject, setSubject] = useState(report.emailSubject);
  const [body, setBody] = useState(report.emailBody);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await workspace.updateReport(report.id, {
        recipient: to.trim() || null,
        emailSubject: subject,
        emailBody: body,
      });
      toast.success("Draft saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function status(value: Report["status"]) {
    try {
      await workspace.updateReport(report.id, { status: value });
      onClose();
    } catch {
      toast.error("The report could not be updated.");
    }
  }

  async function remove() {
    try {
      await workspace.deleteReport(report.id);
      onClose();
    } catch {
      toast.error("The report could not be deleted.");
    }
  }

  const validRecipient = /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(to.trim());
  const email = `mailto:${to.trim()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <Modal title="Review report" onClose={onClose} wide>
      <div className="report-editor">
        <header>
          <span className="eyebrow">{statuses[report.status]}</span>
          <h2>{report.category}</h2>
          <p>{report.address}</p>
        </header>
        <div className="report-editor-grid">
          <aside>
            {report.hasPhoto && (
              <>
                <img
                  className="report-photo"
                  src={`/api/reports/${report.id}/photo`}
                  alt="Your report"
                />
                <a className="text-button" href={`/api/reports/${report.id}/photo?download=1`}>
                  Download photo to attach
                  <ArrowUpRight size={13} />
                </a>
              </>
            )}
            <p>{report.description}</p>
            <small>{report.municipality}</small>
            <button className="text-button danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} />
              Delete report
            </button>
            {confirmDelete && (
              <div className="delete-confirm">
                <p>Delete this report and its photo?</p>
                <button onClick={() => setConfirmDelete(false)}>Keep it</button>
                <button className="danger-button" onClick={() => void remove()}>
                  Delete
                </button>
              </div>
            )}
          </aside>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h3>Email draft</h3>
            <label>
              To
              <input
                type="email"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                placeholder="Municipal contact email"
              />
            </label>
            {!report.recipient && (
              <a
                className="text-button"
                href={contactFor(report.municipality).url}
                target="_blank"
                rel="noreferrer"
              >
                Find the official contact
                <ArrowUpRight size={12} />
              </a>
            )}
            <label>
              Subject
              <input
                required
                maxLength={220}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </label>
            <label>
              Message
              <textarea
                required
                maxLength={5000}
                rows={10}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button className="secondary-button" disabled={busy}>
                Save draft
              </button>
              <a
                className={`primary-button ${!validRecipient ? "disabled" : ""}`}
                aria-disabled={!validRecipient}
                href={validRecipient ? email : undefined}
              >
                Open email
                <ArrowUpRight size={13} />
              </a>
            </div>
            <small>
              {report.hasPhoto ? "Attach your photo in your email app." : "You review and send."}
            </small>
          </form>
        </div>
        <footer className="button-row">
          {report.status === "draft_ready" && (
            <button className="secondary-button" onClick={() => void status("marked_sent")}>
              I sent this email
            </button>
          )}
          <button
            className="secondary-button"
            onClick={() => void status(report.status === "resolved" ? "draft_ready" : "resolved")}
          >
            {report.status === "resolved" ? "Reopen report" : "Mark resolved"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}

export default function ReportsPage({ workspace, onCreate }: Props) {
  const [selected, setSelected] = useState<Report | null>(null);
  return (
    <section className="content-page">
      <header className="page-heading">
        <div>
          <h1>Reports</h1>
        </div>
        <button className="primary-button" disabled={!workspace.ready} onClick={onCreate}>
          <Plus size={15} />
          New report
        </button>
      </header>
      {!workspace.reports.length && (
        <div className="empty-state">
          <FileText size={25} />
          <h2>No reports yet</h2>
          <p>Choose a location on the map to report an issue.</p>
        </div>
      )}
      <div className="workspace-list">
        {workspace.reports.map((report) => (
          <button key={report.id} onClick={() => setSelected(report)}>
            <FileText size={18} />
            <span>
              <strong>{report.category}</strong>
              <small>{report.address}</small>
            </span>
            <span className="status-pill">{statuses[report.status]}</span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      {selected && (
        <ReportEditor report={selected} workspace={workspace} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
