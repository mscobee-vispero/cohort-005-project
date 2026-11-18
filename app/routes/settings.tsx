import { useRef, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/settings";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  UserRole,
  RefundRequestStatus,
  RefundStatus,
  users,
  courses,
  purchases,
  refundRequests,
  refunds,
} from "~/db/schema";
import { AlertTriangle } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";
import { db } from "~/db";
import { desc, eq } from "drizzle-orm";
import { formatPrice } from "~/lib/utils";
import { withdrawRefundRequest } from "~/lib/refunds.server";

const settingsActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("update-profile"),
    name: z.string().trim().min(1, "Name cannot be empty."),
    bio: z.string().trim().optional(),
  }),
  z.object({
    intent: z.literal("withdraw-refund-request"),
    refundRequestId: z.coerce.number().int(),
  }),
]);

export function meta() {
  return [
    { title: "Settings — Cadence" },
    { name: "description", content: "Edit your profile details" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to edit your details.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser) {
    throw data("User not found.", { status: 404 });
  }

  const learnerRefundRequests = db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      refundStatus: refunds.status,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(eq(purchases.userId, currentUserId))
    .orderBy(desc(refundRequests.requestedAt))
    .all();

  return {
    user: {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      bio: currentUser.bio,
      role: currentUser.role,
    },
    refundRequests: learnerRefundRequests,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();
  if (!currentUser) {
    throw data("User not found.", { status: 404 });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, settingsActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  if (parsed.data.intent === "withdraw-refund-request") {
    // Throws 404 unless the Refund Request is on this learner's own purchase.
    withdrawRefundRequest(parsed.data.refundRequestId, currentUser.id);
    return { withdrawn: true };
  }

  const { name, bio } = parsed.data;

  db
    .update(users)
    .set({ name, email: currentUser.email, bio: bio || null })
    .where(eq(users.id, currentUser.id))
    .returning()
    .get();
  return { success: true };
}

// One line per status, named exactly as in GLOSSARY.md. Adding a status to
// the enum is a type error here until it gets its own line.
const BADGE_BASE = "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium";

const badgeTones = {
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  emerald:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  slate: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
  sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  red: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  outline:
    "border border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-400",
};

type Badge = { label: string; tone: keyof typeof badgeTones };

const refundRequestBadges: Record<RefundRequestStatus, Badge> = {
  [RefundRequestStatus.Open]: { label: "Open", tone: "amber" },
  [RefundRequestStatus.Approved]: { label: "Approved", tone: "emerald" },
  [RefundRequestStatus.Declined]: { label: "Declined", tone: "slate" },
  [RefundRequestStatus.Withdrawn]: { label: "Withdrawn", tone: "outline" },
};

const refundBadges: Record<RefundStatus, Badge> = {
  [RefundStatus.Pending]: { label: "Refund pending", tone: "sky" },
  [RefundStatus.Issued]: { label: "Refund issued", tone: "emerald" },
  [RefundStatus.Failed]: { label: "Refund failed", tone: "red" },
};

function StatusBadge({ badge }: { badge: Badge }) {
  return (
    <span className={`${BADGE_BASE} ${badgeTones[badge.tone]}`}>
      {badge.label}
    </span>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { user, refundRequests } = loaderData;
  const openCount = refundRequests.filter(
    (refundRequest) => refundRequest.status === RefundRequestStatus.Open
  ).length;
  const fetcher = useFetcher();
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      toast.success("Profile updated successfully.");
    }
    if (fetcher.state === "idle" && fetcher.data?.errors) {
      const firstError = Object.values(fetcher.data.errors)[0] as string | undefined;
      if (firstError) toast.error(firstError);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Settings</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Update your profile details
        </p>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <h2 className="text-lg font-semibold">Profile</h2>
        </CardHeader>
        <CardContent>
          <fetcher.Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="update-profile" />
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                ref={nameInputRef}
                id="name"
                name="name"
                type="text"
                defaultValue={user.name}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={user.email}
                disabled
                className="text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed.
              </p>
            </div>
            {user.role === UserRole.Instructor && (
              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  name="bio"
                  rows={4}
                  defaultValue={user.bio ?? ""}
                  placeholder="Tell students about yourself..."
                />
                <p className="text-xs text-muted-foreground">
                  Your bio is shown on your course pages.
                </p>
              </div>
            )}
            <Button
              type="submit"
              disabled={fetcher.state !== "idle"}
            >
              {fetcher.state !== "idle" ? "Saving..." : "Save Changes"}
            </Button>
          </fetcher.Form>
        </CardContent>
      </Card>

      {refundRequests.length > 0 && (
        <Card className="mt-8 max-w-md">
          <CardHeader>
            <h2 className="text-lg font-semibold">Refund Requests</h2>
            {openCount > 0 && (
              <p className="text-sm text-muted-foreground">
                {openCount === 1
                  ? "One Open Refund Request is waiting on us."
                  : `${openCount} Open Refund Requests are waiting on us.`}
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {refundRequests.map((refundRequest) => (
              <div key={refundRequest.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-3">
                  <Link
                    to={`/courses/${refundRequest.courseSlug}`}
                    className="font-medium hover:underline"
                  >
                    {refundRequest.courseTitle}
                  </Link>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge
                      badge={refundRequestBadges[refundRequest.status]}
                    />
                    {refundRequest.refundStatus && (
                      <StatusBadge
                        badge={refundBadges[refundRequest.refundStatus]}
                      />
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {formatPrice(refundRequest.amountPaid)} · raised{" "}
                  {new Date(refundRequest.requestedAt).toLocaleDateString()}
                </p>
                <p className="mt-2 text-sm">{refundRequest.reason}</p>
                {refundRequest.status === RefundRequestStatus.Open && (
                  <WithdrawRefundRequest refundRequestId={refundRequest.id} />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Lets the learner take back their own Open Refund Request. Asks once before
 * withdrawing, the same way the course page asks before raising one.
 */
function WithdrawRefundRequest({
  refundRequestId,
}: {
  refundRequestId: number;
}) {
  const fetcher = useFetcher<typeof action>();
  const [isConfirming, setIsConfirming] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "withdrawn" in fetcher.data) {
      toast.success("Your Refund Request is Withdrawn.");
    }
  }, [fetcher.state, fetcher.data]);

  if (!isConfirming) {
    return (
      <div className="mt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setIsConfirming(true)}
        >
          Withdraw
        </Button>
      </div>
    );
  }

  return (
    <fetcher.Form method="post" className="mt-3 space-y-2">
      <input type="hidden" name="intent" value="withdraw-refund-request" />
      <input type="hidden" name="refundRequestId" value={refundRequestId} />
      <p className="text-xs text-muted-foreground">
        Withdraw this Refund Request? There will be no Refund. You may raise a
        new Refund Request from the course page while you are still eligible.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Withdrawing..." : "Withdraw it"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsConfirming(false)}
        >
          Keep it
        </Button>
      </div>
    </fetcher.Form>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 404) {
      title = "User not found";
      message =
        typeof error.data === "string" ? error.data : "User not found.";
    } else {
      title = `Error ${error.status}`;
      message =
        typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
