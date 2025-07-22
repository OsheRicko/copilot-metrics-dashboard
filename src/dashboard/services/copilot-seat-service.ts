import { formatResponseError, unknownResponseError } from "@/features/common/response-error";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { ensureGitHubEnvConfig } from "./env-service";
import { CopilotSeatsData, SeatAssignment, GitHubTeam } from "@/features/common/models";
import { cosmosClient, cosmosConfiguration } from "./cosmos-db-service";
import { format } from "date-fns";
import { SqlQuerySpec } from "@azure/cosmos";
import { stringIsNullOrEmpty } from "../utils/helpers";

export interface IFilter {
  date?: Date;
  enterprise: string;
  organization: string;
  team: string[];
  page: number;
}

export const getCopilotSeats = async (
  filter: IFilter
): Promise<ServerActionResponse<CopilotSeatsData>> => {  
  const env = ensureGitHubEnvConfig();
  const isCosmosConfig = cosmosConfiguration();

  if (env.status !== "OK") {
    return env;
  }

  const { enterprise, organization } = env.response;

  try {
    switch (process.env.GITHUB_API_SCOPE) {
      case "enterprise":
        if (stringIsNullOrEmpty(filter.enterprise)) {
          filter.enterprise = enterprise;
        }
        break;
      default:
        if (stringIsNullOrEmpty(filter.organization)) {
          filter.organization = organization;
        }
        break;
    }
    if (isCosmosConfig) {
      const result = await getCopilotSeatsFromDatabase(filter);
      return result;
    }
    const result = await getCopilotSeatsFromApi(filter);
    return result;
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getDataFromDatabase = async (
  filter: IFilter
): Promise<ServerActionResponse<CopilotSeatsData[]>> => {
  try {
    const client = cosmosClient();
    const database = client.database("platform-engineering");
    const container = database.container("seats_history");

    let date = "";
    const maxDays = 365 * 2; // maximum 2 years of data

    if (filter.date) {
      date = format(filter.date, "yyyy-MM-dd");
    } else {
      const today = Date.now();
      date = format(today, "yyyy-MM-dd");
    }

    let querySpec: SqlQuerySpec = {
      query: `SELECT * FROM c WHERE c.date = @date`,
      parameters: [{ name: "@date", value: date }],
    };
    if (filter.enterprise) {
      querySpec.query += ` AND c.enterprise = @enterprise`;
      querySpec.parameters?.push({
        name: "@enterprise",
        value: filter.enterprise,
      });
    }
    if (filter.organization) {
      querySpec.query += ` AND c.organization = @organization`;
      querySpec.parameters?.push({
        name: "@organization",
        value: filter.organization,
      });
    }
    if (filter.team && filter.team.length > 0) {
      // For seats data, teams are stored in the seats array as assigning_team
      // We need to filter documents that have seats with matching assigning_team names
      if (filter.team.length === 1) {
        querySpec.query += ` AND EXISTS (SELECT VALUE 1 FROM seat IN c.seats WHERE seat.assigning_team.name = @team)`;
        querySpec.parameters?.push({ name: "@team", value: filter.team[0] });
      } else {
        const teamConditions = filter.team
          .map((_, index) => `seat.assigning_team.name = @team${index}`)
          .join(" OR ");
        querySpec.query += ` AND EXISTS (SELECT VALUE 1 FROM seat IN c.seats WHERE ${teamConditions})`;
        filter.team.forEach((team, index) => {
          querySpec.parameters?.push({ name: `@team${index}`, value: team });
        });
      }
    }
    if (filter.page) {
      querySpec.query += ` AND c.page = @page`;
      querySpec.parameters?.push({ name: "@page", value: filter.page });
    }

    let { resources } = await container.items
      .query<CopilotSeatsData>(querySpec, {
        maxItemCount: maxDays,
      })
      .fetchAll();

    // Guarantee backwards compatibility with documents that don't have the page property
    // Check if the resources array is empty, remove the page query and try again
    if (resources.length === 0 && querySpec.query.includes("c.page")) {
      querySpec.query = querySpec.query.replace(/ AND c.page = @page/, "");
      querySpec.parameters = querySpec.parameters?.filter(
        (param) => param.name !== "@page"
      );
      resources = (
        await container.items
          .query<CopilotSeatsData>(querySpec, {
            maxItemCount: maxDays,
          })
          .fetchAll()
      ).resources;
    }

    return {
      status: "OK",
      response: resources,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getCopilotSeatsFromDatabase = async (
  filter: IFilter
): Promise<ServerActionResponse<CopilotSeatsData>> => {
  try {
    const data = await getDataFromDatabase(filter);

    if (data.status !== "OK" || !data.response) {
      return {
        status: "ERROR",
        errors: [{ message: "No data found" }],
      };
    }

    const seatsData = await aggregateSeatsData(data.response, filter.team);

    return {
      status: "OK",
      response: seatsData,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getDataFromApi = async (
  filter: IFilter
): Promise<ServerActionResponse<CopilotSeatsData[]>> => {
  const env = ensureGitHubEnvConfig();

  if (env.status !== "OK") {
    return env;
  }

  let { token, version } = env.response;

  try {
    if (filter.enterprise) {
      let enterpriseSeats: CopilotSeatsData[] = [];
      let pageCount = 1;
      let url = `https://api.github.com/enterprises/${filter.enterprise}/copilot/billing/seats?per_page=100`;

      do {
        const enterpriseResponse = await fetch(url, {
          cache: "no-store",
          headers: {
            Accept: `application/vnd.github+json`,
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": version,
          },
        });

        if (!enterpriseResponse.ok) {
          return formatResponseError(filter.enterprise, enterpriseResponse);
        }

        const enterpriseData = await enterpriseResponse.json();
        const enterpriseSeat: CopilotSeatsData = {
          enterprise: filter.enterprise,
          seats: enterpriseData.seats,
          total_seats: enterpriseData.total_seats,
          total_active_seats: 0,
          page: pageCount,
          has_next_page: false,
          last_update: null,
          date: "",
          id: "",
          organization: null,
        };

        const linkHeader = enterpriseResponse.headers.get("Link");
        url = getNextUrlFromLinkHeader(linkHeader) || "";
        enterpriseSeat.has_next_page = !stringIsNullOrEmpty(url);
        enterpriseSeats.push(enterpriseSeat);
        pageCount++;
      } while (!stringIsNullOrEmpty(url));

      // Calculate total active seats for each page as the count of all active seats across all pages
      const allActiveSeatsCount = enterpriseSeats
        .flatMap((s) => s.seats)
        .filter((seat) => {
          if (!seat.last_activity_at) return false;
          const lastActivityDate = new Date(seat.last_activity_at);
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          return lastActivityDate >= thirtyDaysAgo;
        }).length;

      enterpriseSeats.forEach((seatPage) => {
        seatPage.total_active_seats = allActiveSeatsCount;
      });

      return {
        status: "OK",
        response: enterpriseSeats,
      };
    }

    let organizationSeats: CopilotSeatsData[] = [];
    let pageCount = 1;
    let url = `https://api.github.com/orgs/${filter.organization}/copilot/billing/seats?per_page=100`;
    do {
      const organizationResponse = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: `application/vnd.github+json`,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": version,
        },
      });

      if (!organizationResponse.ok) {
        return formatResponseError(filter.organization, organizationResponse);
      }

      const organizationData = await organizationResponse.json();
      const organizationSeat: CopilotSeatsData = {
        organization: filter.organization,
        seats: organizationData.seats,
        total_seats: organizationData.total_seats,
        total_active_seats: 0,
        page: pageCount,
        has_next_page: false,
        last_update: null,
        date: "",
        id: "",
        enterprise: null,
      };

      const linkHeader = organizationResponse.headers.get("Link");
      url = getNextUrlFromLinkHeader(linkHeader) || "";
      organizationSeat.has_next_page = !stringIsNullOrEmpty(url);
      organizationSeats.push(organizationSeat);
      pageCount++;
    } while (!stringIsNullOrEmpty(url));

    // Calculate total active seats for each page as the count of all active seats across all pages
    const allActiveSeatsCount = organizationSeats
      .flatMap((s) => s.seats)
      .filter((seat) => {
        if (!seat.last_activity_at) return false;
        const lastActivityDate = new Date(seat.last_activity_at);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        return lastActivityDate >= thirtyDaysAgo;
      }).length;

    organizationSeats.forEach((seatPage) => {
      seatPage.total_active_seats = allActiveSeatsCount;
    });

    return {
      status: "OK",
      response: organizationSeats,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getCopilotSeatsFromApi = async (
  filter: IFilter
): Promise<ServerActionResponse<CopilotSeatsData>> => {
  try {
    const data = await getDataFromApi(filter);

    if (data.status !== "OK" || !data.response) {
      return {
        status: "ERROR",
        errors: [{ message: "No data found" }],
      };
    }

    const seatsData = await aggregateSeatsData(data.response, filter.team);

    return {
      status: "OK",
      response: seatsData,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

export const getCopilotSeatsManagement = async (
  filter: IFilter
): Promise<ServerActionResponse<CopilotSeatsData>> => {  
  const env = ensureGitHubEnvConfig();
  const isCosmosConfig = cosmosConfiguration();

  if (env.status !== "OK") {
    return env;
  }

  const { enterprise, organization } = env.response;

  try {
    switch (process.env.GITHUB_API_SCOPE) {
      case "enterprise":
        if (stringIsNullOrEmpty(filter.enterprise)) {
          filter.enterprise = enterprise;
        }
        break;
      default:
        if (stringIsNullOrEmpty(filter.organization)) {
          filter.organization = organization;
        }
        break;
    }

    if (isCosmosConfig) {
      const data = await getCopilotSeatsFromDatabase(filter);

      if (data.status !== "OK" || !data.response) {
        return {
          status: "OK",
          response: {} as CopilotSeatsData,
        };
      }

      const seatsData = data.response;
      return {
        status: "OK",
        response: seatsData as CopilotSeatsData,
      };
    }

    const data = await getCopilotSeatsFromApi(filter);

    if (data.status !== "OK" || !data.response) {
      return {
        status: "OK",
        response: {} as CopilotSeatsData,
      };
    }

    const seatsData = data.response;

    return {
      status: "OK",
      response: seatsData as CopilotSeatsData,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getNextUrlFromLinkHeader = (linkHeader: string | null): string | null => {
  if (!linkHeader) return null;

  const links = linkHeader.split(",");
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === "next") {
      return match[1];
    }
  }
  return null;
};

/**
 * Filter seats by team membership when assigning_team is not available
 * Falls back to GitHub Teams API to get team members and filter accordingly
 * Supports hierarchical teams - includes child team members when parent team is selected
 */
const filterSeatsByTeam = async (
  seats: SeatAssignment[],
  teamFilter: string[]
): Promise<SeatAssignment[]> => {
  // First, try the standard filtering based on assigning_team
  const seatsWithTeams = seats.filter(
    (seat) =>
      seat.assigning_team?.name &&
      teamFilter.includes(seat.assigning_team.name)
  );

  // If we found seats with team assignments, use those
  if (seatsWithTeams.length > 0) {
    return seatsWithTeams;
  }

  // If no seats have team assignments, fall back to team membership API
  try {
    const env = ensureGitHubEnvConfig();
    
    if (env.status === "OK" && env.response) {
      const { organization, token } = env.response;
      
      // Get team members for each selected team including child teams
      const teamMembers = new Set<string>();
      
      for (const teamName of teamFilter) {
        // Get direct members of the team
        await getTeamMembers(organization, token, teamName, teamMembers);
        
        // Get child teams and their members (for hierarchical support)
        await getChildTeamMembers(organization, token, teamName, teamMembers);
      }

      // Filter seats based on team membership
      const filteredSeats = seats.filter((seat) => 
        teamMembers.has(seat.assignee.login)
      );
      
      return filteredSeats;
    }
  } catch (error) {
    console.error("Error in team membership filtering:", error);
  }

  // If all else fails, return empty array when teams are selected but no matches found
  return [];
};

/**
 * Get direct members of a team
 */
const getTeamMembers = async (
  organization: string,
  token: string,
  teamName: string,
  teamMembers: Set<string>
): Promise<void> => {
  try {
    let teamMembersUrl = `https://api.github.com/orgs/${organization}/teams/${teamName}/members?per_page=100`;
    
    while (teamMembersUrl) {
      const response = await fetch(teamMembersUrl, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      
      if (response.ok) {
        const members = await response.json();
        
        members.forEach((member: any) => {
          if (member.login) {
            teamMembers.add(member.login);
          }
        });
        
        // Check for pagination in the Link header
        const linkHeader = response.headers.get("Link");
        if (linkHeader) {
          const nextLinkMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          teamMembersUrl = nextLinkMatch ? nextLinkMatch[1] : null;
        } else {
          teamMembersUrl = null;
        }
      } else {
        const errorText = await response.text();
        console.warn(`Failed to fetch members for team ${teamName}: ${response.status} - ${errorText}`);
        break;
      }
    }
  } catch (error) {
    console.warn(`Error fetching members for team ${teamName}:`, error);
  }
};

/**
 * Get child teams and their members for hierarchical team support
 */
const getChildTeamMembers = async (
  organization: string,
  token: string,
  parentTeamName: string,
  teamMembers: Set<string>
): Promise<void> => {
  try {
    // Special handling for known hierarchical structure
    // Birdeye_team is the parent of Insights_team and labs_team
    if (parentTeamName === 'Birdeye_team') {
      // Get members from known child teams
      await getTeamMembers(organization, token, 'Insights_team', teamMembers);
      await getTeamMembers(organization, token, 'labs_team', teamMembers);
      return;
    }
    
    // Generic approach: get all teams to find children of the parent team
    const allTeamsUrl = `https://api.github.com/orgs/${organization}/teams?per_page=100`;
    
    const response = await fetch(allTeamsUrl, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (response.ok) {
      const allTeams = await response.json();
      
      // Filter teams that have the parent team as their parent
      const childTeams = allTeams.filter((team: any) => 
        team.parent && team.parent.name === parentTeamName
      );
      
      // Get members from each child team
      for (const childTeam of childTeams) {
        await getTeamMembers(organization, token, childTeam.name, teamMembers);
      }
    } else {
      const errorText = await response.text();
      console.warn(`Failed to fetch teams for organization ${organization}: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.warn(`Error fetching child teams for ${parentTeamName}:`, error);
  }
};

const aggregateSeatsData = async (
  data: CopilotSeatsData[],
  teamFilter?: string[]
): Promise<CopilotSeatsData> => {
  let seats: SeatAssignment[] = [];

  if (data.length === 0) {
    return {
      total_seats: 0,
      total_active_seats: 0,
      seats: seats,
    } as CopilotSeatsData;
  }

  // Garantee backwards compatibility with document without the total_active_seats property
  if (
    data[0].total_active_seats === null ||
    data[0].total_active_seats === undefined
  ) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    data[0].total_active_seats = data[0].seats.filter((seat) => {
      if (!seat.last_activity_at) return false;
      const lastActivityDate = new Date(seat.last_activity_at);
      return lastActivityDate >= thirtyDaysAgo;
    }).length;
  }

  if (data.length === 1) {
    // Apply team filtering if specified
    let filteredSeats = data[0].seats;
    if (teamFilter && teamFilter.length > 0) {
      filteredSeats = await filterSeatsByTeam(data[0].seats, teamFilter);
    }

    // Recalculate totals based on filtered seats
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const activeSeatsCount = filteredSeats.filter((seat) => {
      if (!seat.last_activity_at) return false;
      const lastActivityDate = new Date(seat.last_activity_at);
      return lastActivityDate >= thirtyDaysAgo;
    }).length;

    return {
      ...data[0],
      total_seats: filteredSeats.length,
      total_active_seats: activeSeatsCount,
      seats: filteredSeats,
    };
  }

  // For multiple documents, flatten and deduplicate seats
  const allSeats = data.flatMap((seatData) => seatData.seats);

  // Apply team filtering if specified
  let filteredSeats = allSeats;
  if (teamFilter && teamFilter.length > 0) {
    filteredSeats = await filterSeatsByTeam(allSeats, teamFilter);
  }

  const uniqueSeatsMap = new Map<string, SeatAssignment>();
  filteredSeats.forEach((seat) => {
    if (!uniqueSeatsMap.has(seat.assignee.login)) {
      uniqueSeatsMap.set(seat.assignee.login, seat);
    }
  });

  seats = Array.from(uniqueSeatsMap.values());

  // Recalculate totals based on filtered and deduplicated seats
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const activeSeatsCount = seats.filter((seat) => {
    if (!seat.last_activity_at) return false;
    const lastActivityDate = new Date(seat.last_activity_at);
    return lastActivityDate >= thirtyDaysAgo;
  }).length;

  const aggregatedData: CopilotSeatsData = {
    enterprise: data[0].enterprise,
    organization: data[0].organization,
    total_seats: seats.length,
    total_active_seats: activeSeatsCount,
    page: data[0].page,
    has_next_page: false,
    last_update: data[0].last_update,
    date: data[0].date,
    id: data[0].id,
    seats: seats,
  };

  return aggregatedData;
};

export const getAllCopilotSeatsTeams = async (
  filter: IFilter
): Promise<ServerActionResponse<GitHubTeam[]>> => {
  const env = ensureGitHubEnvConfig();
  const isCosmosConfig = cosmosConfiguration();

  if (env.status !== "OK") {
    return env;
  }

  const { enterprise, organization } = env.response;

  try {
    switch (process.env.GITHUB_API_SCOPE) {
      case "enterprise":
        if (stringIsNullOrEmpty(filter.enterprise)) {
          filter.enterprise = enterprise;
        }
        break;
      default:
        if (stringIsNullOrEmpty(filter.organization)) {
          filter.organization = organization;
        }
        break;
    }
    
    if (isCosmosConfig) {
      const dbResult = await getAllCopilotSeatsTeamsFromDatabase(filter);
      
      if (dbResult.status !== "OK" || !dbResult.response) {
        return {
          status: "ERROR",
          errors: [{ message: "No data found" }],
        };
      }
      return {
        status: "OK",
        response: dbResult.response,
      };
    }
    
    const apiResult = await getAllCopilotSeatsTeamsFromApi(filter);
    if (apiResult.status !== "OK" || !apiResult.response) {
      return {
        status: "ERROR",
        errors: [{ message: "No data found" }],
      };
    }
    return {
      status: "OK",
      response: apiResult.response,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getAllCopilotSeatsTeamsFromDatabase = async (
  filter: IFilter
): Promise<ServerActionResponse<GitHubTeam[]>> => {
  try {
    const client = cosmosClient();
    const database = client.database("platform-engineering");
    const container = database.container("seats_history");

    let date = "";
    if (filter.date) {
      date = format(filter.date, "yyyy-MM-dd");
    } else {
      const today = Date.now();
      date = format(today, "yyyy-MM-dd");
    }

    let querySpec: SqlQuerySpec = {
      query: `SELECT DISTINCT VALUE seat.assigning_team FROM c JOIN seat IN c.seats WHERE IS_DEFINED(seat.assigning_team) AND seat.assigning_team != null AND c.date = @date`,
      parameters: [{ name: "@date", value: date }],
    };
    if (filter.enterprise) {
      querySpec.query += ` AND c.enterprise = @enterprise`;
      querySpec.parameters?.push({
        name: "@enterprise",
        value: filter.enterprise,
      });
    }
    if (filter.organization) {
      querySpec.query += ` AND c.organization = @organization`;
      querySpec.parameters?.push({
        name: "@organization",
        value: filter.organization,
      });
    }
    const { resources } = await container.items
      .query<any>(querySpec)
      .fetchAll();
    const teams = resources.sort((a: GitHubTeam, b: GitHubTeam) =>
      (a.name || "").localeCompare(b.name || "")
    );

    return {
      status: "OK",
      response: teams,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};

const getAllCopilotSeatsTeamsFromApi = async (
  filter: IFilter
): Promise<ServerActionResponse<GitHubTeam[]>> => {
  const env = ensureGitHubEnvConfig();
  if (env.status !== "OK") {
    return env;
  }
  let { token, version } = env.response;
  
  try {
    let url = "";
    if (filter.enterprise) {
      url = `https://api.github.com/enterprises/${filter.enterprise}/copilot/billing/seats?per_page=100`;
    } else {
      url = `https://api.github.com/orgs/${filter.organization}/copilot/billing/seats?per_page=100`;
    }

    let teams: GitHubTeam[] = [];
    let nextUrl = url;
    do {
      const response = await fetch(nextUrl, {
        cache: "no-store",
        headers: {
          Accept: `application/vnd.github+json`,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": version,
        },
      });
      
      if (!response.ok) {
        return formatResponseError(
          filter.enterprise || filter.organization,
          response
        );
      }
      
      const data = await response.json();
      
      if (data.seats && Array.isArray(data.seats)) {
        const pageTeams = data.seats
          .map((seat: any) => seat.assigning_team)
          .filter((team: any) => !!team);
        teams.push(...pageTeams);
      }
      const linkHeader = response.headers.get("Link");
      nextUrl = getNextUrlFromLinkHeader(linkHeader) || "";
    } while (nextUrl);

    // If no teams found from seats assignments, try to get teams from GitHub Teams API as fallback
    if (teams.length === 0) {
      let teamsUrl = "";
      if (filter.enterprise) {
        // For enterprise, we'd need a different approach - skipping for now
      } else {
        teamsUrl = `https://api.github.com/orgs/${filter.organization}/teams?per_page=100`;
        
        try {
          let nextTeamsUrl = teamsUrl;
          do {
            const teamsResponse = await fetch(nextTeamsUrl, {
              cache: "no-store",
              headers: {
                Accept: `application/vnd.github+json`,
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": version,
              },
            });
            
            if (teamsResponse.ok) {
              const teamsData = await teamsResponse.json();
              if (Array.isArray(teamsData)) {
                teams.push(...teamsData);
              }
              const linkHeader = teamsResponse.headers.get("Link");
              nextTeamsUrl = getNextUrlFromLinkHeader(linkHeader) || "";
            } else {
              break;
            }
          } while (nextTeamsUrl);
        } catch (teamsError) {
          // Continue with empty teams rather than failing
        }
      }
    }

    // Remove duplicates based on team id or name
    const uniqueTeams = teams.filter(
      (team, index, self) =>
        index ===
        self.findIndex((t) => (t.id ? t.id === team.id : t.name === team.name))
    );

    return {
      status: "OK",
      response: uniqueTeams,
    };
  } catch (e) {
    return unknownResponseError(e);
  }
};
