"use client";
import { useDashboard } from "./seats-state";
import { ChartHeader } from "@/features/common/chart-header";
import { Card, CardContent } from "@/components/ui/card";
import { stringIsNullOrEmpty } from "@/utils/helpers";
import { DataTable } from "@/components/ui/data-table";
import { ColumnDef } from "@tanstack/react-table";
import { DataTableColumnHeader } from "@/components/ui/data-table-column-header";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Loader2 } from "lucide-react";

interface SeatData {
    user: string;
    name: string | null;
    userUrl: string;
    organization: string | null;
    team: string | null;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
    lastActivityEditor: string;
    planType: string;
    pendingCancellationDate: string;
}

function formatEditorName(editor: string): string {
    if (stringIsNullOrEmpty(editor)) {
        return editor;
    }
    const editorInfo = editor.split('/');
    const editorName = `${editorInfo[0]} (${editorInfo[1]})`;

    return editorName;
}

// Component for fetching and displaying user name
// The GitHub Copilot Seats API returns assignee.url (e.g., https://api.github.com/users/username)
// This component uses that URL to fetch additional user details including the display name
function UserNameCell({ userUrl, initialName }: { userUrl: string; initialName?: string | null }) {
    const [name, setName] = useState<string | null>(initialName || null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchUserName = async () => {
        if (name || isLoading) return; // Already fetched or currently fetching
        
        setIsLoading(true);
        setError(null);
        try {
            const response = await fetch(userUrl);
            if (response.ok) {
                const userData = await response.json();
                setName(userData.name || 'No name available');
            } else {
                setError('Failed to fetch');
                setName('Failed to fetch');
            }
        } catch (error) {
            console.error('Error fetching user data:', error);
            setError('Error fetching name');
            setName('Error fetching name');
        } finally {
            setIsLoading(false);
        }
    };

    // If we already have a name from the initial data, just display it
    if (name && !error) {
        return <div className="ml-2">{name}</div>;
    }

    // If we had an error, show error state with retry option
    if (error) {
        return (
            <div className="ml-2">
                <span className="text-red-500 text-xs mr-2">{error}</span>
                <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => {
                        setError(null);
                        setName(null);
                        fetchUserName();
                    }}
                    disabled={isLoading}
                >
                    Retry
                </Button>
            </div>
        );
    }

    // Show fetch button if no name is available
    return (
        <div className="ml-2">
            <Button 
                variant="outline" 
                size="sm" 
                onClick={fetchUserName}
                disabled={isLoading}
            >
                {isLoading ? (
                    <>
                        <Loader2 size={14} className="animate-spin mr-1" />
                        Loading...
                    </>
                ) : 'Fetch Name'}
            </Button>
        </div>
    );
}

const arrayIncludes = (row: any, id: string, value: any[]) => {
    return value.includes(row.getValue(id));
};

const stringIncludes = (row: any, id: string, value: string) => {
    return row.getValue(id).includes(value);
};

const columns: ColumnDef<SeatData>[] = [
    { accessorKey: "user", title: "User", filter: stringIncludes },
    { 
        accessorKey: "name", 
        title: "Name", 
        filter: stringIncludes,
        customCell: true // Custom flag to indicate this needs special rendering
    },
    { accessorKey: "organization", title: "Organization", filter: arrayIncludes },
    { accessorKey: "team", title: "Team", filter: arrayIncludes },
    { accessorKey: "createdAt", title: "Create Date" },
    { accessorKey: "updatedAt", title: "Update Date" },
    { accessorKey: "lastActivityAt", title: "Last Activity Date" },
    { accessorKey: "lastActivityEditor", title: "Last Activity Editor" },
    { accessorKey: "planType", title: "Plan", filter: arrayIncludes },
    { accessorKey: "pendingCancellationDate", title: "Pending Cancellation" }
].map((col) => ({
    accessorKey: col.accessorKey,
    id: col.accessorKey,
    meta: { name: col.title },
    header: ({ column }) => (
        <DataTableColumnHeader
            column={column}
            title={col.title}
        />
    ),
    cell: ({ row }) => {
        if (col.accessorKey === "name") {
            return <UserNameCell userUrl={row.original.userUrl} initialName={row.getValue("name")} />;
        }
        return <div className="ml-2">{row.getValue(col.accessorKey)}</div>;
    },
    filterFn: col.filter,
}));

export const SeatsList = () => {
    const { seatsData } = useDashboard();
    const hasOrganization = seatsData?.seats.some((seat) => seat.organization);
    const hasTeam = seatsData?.seats.some((seat) => seat.assigning_team);
    return (
        <Card className="col-span-4">
            <ChartHeader
                title="Assigned Seats"
                description=""
            />
            <CardContent>
                <DataTable
                    columns={columns.filter((col) => col.id !== "organization" || hasOrganization)}
                    data={(seatsData?.seats ?? []).map((seat) => ({
                        user: seat.assignee.login,
                        name: seat.assignee.name,
                        userUrl: seat.assignee.url,
                        organization: seat.organization?.login,
                        team: seat.assigning_team?.name,
                        createdAt: new Date(seat.created_at).toLocaleDateString(),
                        updatedAt: new Date(seat.updated_at).toLocaleDateString(),
                        lastActivityAt: seat.last_activity_at ? new Date(seat.last_activity_at).toLocaleDateString() : "-",
                        lastActivityEditor: formatEditorName(seat.last_activity_editor),
                        planType: seat.plan_type,
                        pendingCancellationDate: seat.pending_cancellation_date ? new Date(seat.pending_cancellation_date).toLocaleDateString() : "N/A",
                    }))}
                    initialVisibleColumns={{
                        updatedAt: false,
                        planType: false,
                        pendingCancellationDate: false,
                    }}
                    search={{
                        column: "user",
                        placeholder: "Filter seats...",
                    }}
                    filters={[
                        ...(hasOrganization ? [{ column: "organization", label: "Organizations" }] : []), 
                        ...(hasTeam ? [{ column: "team", label: "Team" }] : []),
                        { column: "planType", label: "Plan Type" }
                    ]}
                    enableExport
                />
            </CardContent>
        </Card>
    );
};
