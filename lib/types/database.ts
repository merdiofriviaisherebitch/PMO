export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      approvals: {
        Row: {
          actioned_at: string
          actor_id: string | null
          department_id: string | null
          entity_id: string
          entity_type: string
          from_status: Database["public"]["Enums"]["update_status"] | null
          id: number
          notes: string | null
          project_id: string | null
          to_status: Database["public"]["Enums"]["update_status"]
        }
        Insert: {
          actioned_at?: string
          actor_id?: string | null
          department_id?: string | null
          entity_id: string
          entity_type?: string
          from_status?: Database["public"]["Enums"]["update_status"] | null
          id?: never
          notes?: string | null
          project_id?: string | null
          to_status: Database["public"]["Enums"]["update_status"]
        }
        Update: {
          actioned_at?: string
          actor_id?: string | null
          department_id?: string | null
          entity_id?: string
          entity_type?: string
          from_status?: Database["public"]["Enums"]["update_status"] | null
          id?: never
          notes?: string | null
          project_id?: string | null
          to_status?: Database["public"]["Enums"]["update_status"]
        }
        Relationships: [
          {
            foreignKeyName: "approvals_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          actor_id: string | null
          actor_snapshot: Json | null
          department_id: string | null
          entity_id: string
          entity_type: string
          id: number
          new_values: Json | null
          occurred_at: string
          old_values: Json | null
          project_id: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          actor_id?: string | null
          actor_snapshot?: Json | null
          department_id?: string | null
          entity_id: string
          entity_type: string
          id?: never
          new_values?: Json | null
          occurred_at?: string
          old_values?: Json | null
          project_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          actor_id?: string | null
          actor_snapshot?: Json | null
          department_id?: string | null
          entity_id?: string
          entity_type?: string
          id?: never
          new_values?: Json | null
          occurred_at?: string
          old_values?: Json | null
          project_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      baselines: {
        Row: {
          id: string
          locked_at: string
          locked_by: string | null
          name: string
          project_id: string
          snapshot: Json
        }
        Insert: {
          id?: string
          locked_at?: string
          locked_by?: string | null
          name: string
          project_id: string
          snapshot: Json
        }
        Update: {
          id?: string
          locked_at?: string
          locked_by?: string | null
          name?: string
          project_id?: string
          snapshot?: Json
        }
        Relationships: [
          {
            foreignKeyName: "baselines_locked_by_fkey"
            columns: ["locked_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "baselines_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      budget_actuals: {
        Row: {
          amount: number
          budget_id: string
          description: string | null
          id: string
          recorded_at: string
          recorded_by: string | null
        }
        Insert: {
          amount: number
          budget_id: string
          description?: string | null
          id?: string
          recorded_at?: string
          recorded_by?: string | null
        }
        Update: {
          amount?: number
          budget_id?: string
          description?: string | null
          id?: string
          recorded_at?: string
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "budget_actuals_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_actuals_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      budgets: {
        Row: {
          amber_pct: number
          approved_at: string
          approved_by: string | null
          budget_amount: number
          id: string
          red_pct: number
          workspace_id: string
        }
        Insert: {
          amber_pct?: number
          approved_at?: string
          approved_by?: string | null
          budget_amount: number
          id?: string
          red_pct?: number
          workspace_id: string
        }
        Update: {
          amber_pct?: number
          approved_at?: string
          approved_by?: string | null
          budget_amount?: number
          id?: string
          red_pct?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "department_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      department_updates: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          content: Json
          created_at: string
          cycle_id: string
          id: string
          status: Database["public"]["Enums"]["update_status"]
          submitted_at: string | null
          submitted_by: string | null
          workspace_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          content?: Json
          created_at?: string
          cycle_id: string
          id?: string
          status?: Database["public"]["Enums"]["update_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          workspace_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          content?: Json
          created_at?: string
          cycle_id?: string
          id?: string
          status?: Database["public"]["Enums"]["update_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_updates_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_updates_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "update_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_updates_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_updates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "department_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      department_workspaces: {
        Row: {
          created_at: string
          department_id: string
          id: string
          project_id: string
          rag_status: Database["public"]["Enums"]["rag_status"]
        }
        Insert: {
          created_at?: string
          department_id: string
          id?: string
          project_id: string
          rag_status?: Database["public"]["Enums"]["rag_status"]
        }
        Update: {
          created_at?: string
          department_id?: string
          id?: string
          project_id?: string
          rag_status?: Database["public"]["Enums"]["rag_status"]
        }
        Relationships: [
          {
            foreignKeyName: "department_workspaces_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_workspaces_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      dependencies: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          relation_type: Database["public"]["Enums"]["relation_type"]
          source_department_id: string | null
          source_task_id: string
          target_department_id: string | null
          target_task_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          relation_type?: Database["public"]["Enums"]["relation_type"]
          source_department_id?: string | null
          source_task_id: string
          target_department_id?: string | null
          target_task_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          relation_type?: Database["public"]["Enums"]["relation_type"]
          source_department_id?: string | null
          source_task_id?: string
          target_department_id?: string | null
          target_task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dependencies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dependencies_source_department_id_fkey"
            columns: ["source_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dependencies_source_task_id_fkey"
            columns: ["source_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dependencies_target_department_id_fkey"
            columns: ["target_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dependencies_target_task_id_fkey"
            columns: ["target_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      escalation_events: {
        Row: {
          department_id: string | null
          id: string
          level: number
          project_id: string | null
          resolved_at: string | null
          rule_id: string
          target_entity_id: string
          target_entity_type: string
          triggered_at: string
        }
        Insert: {
          department_id?: string | null
          id?: string
          level: number
          project_id?: string | null
          resolved_at?: string | null
          rule_id: string
          target_entity_id: string
          target_entity_type: string
          triggered_at?: string
        }
        Update: {
          department_id?: string | null
          id?: string
          level?: number
          project_id?: string | null
          resolved_at?: string | null
          rule_id?: string
          target_entity_id?: string
          target_entity_type?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "escalation_events_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalation_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalation_events_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "escalation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      escalation_rules: {
        Row: {
          active: boolean
          created_at: string
          department_id: string | null
          id: string
          period_bucket: Database["public"]["Enums"]["escalation_period"]
          project_id: string | null
          rule_type: Database["public"]["Enums"]["escalation_rule_type"]
        }
        Insert: {
          active?: boolean
          created_at?: string
          department_id?: string | null
          id?: string
          period_bucket: Database["public"]["Enums"]["escalation_period"]
          project_id?: string | null
          rule_type: Database["public"]["Enums"]["escalation_rule_type"]
        }
        Update: {
          active?: boolean
          created_at?: string
          department_id?: string | null
          id?: string
          period_bucket?: Database["public"]["Enums"]["escalation_period"]
          project_id?: string | null
          rule_type?: Database["public"]["Enums"]["escalation_rule_type"]
        }
        Relationships: [
          {
            foreignKeyName: "escalation_rules_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalation_rules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      escalation_steps: {
        Row: {
          id: string
          level: number
          recipient_scope: Database["public"]["Enums"]["recipient_scope"]
          rule_id: string
          threshold_hours: number
        }
        Insert: {
          id?: string
          level: number
          recipient_scope: Database["public"]["Enums"]["recipient_scope"]
          rule_id: string
          threshold_hours: number
        }
        Update: {
          id?: string
          level?: number
          recipient_scope?: Database["public"]["Enums"]["recipient_scope"]
          rule_id?: string
          threshold_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "escalation_steps_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "escalation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_outbox: {
        Row: {
          attempts: number
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at: string
          dedup_key: string
          id: string
          last_error: string | null
          level: number | null
          next_attempt_at: string | null
          recipient_id: string | null
          rule_id: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
          subject: string
        }
        Insert: {
          attempts?: number
          body: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          dedup_key: string
          id?: string
          last_error?: string | null
          level?: number | null
          next_attempt_at?: string | null
          recipient_id?: string | null
          rule_id?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          subject: string
        }
        Update: {
          attempts?: number
          body?: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          dedup_key?: string
          id?: string
          last_error?: string | null
          level?: number | null
          next_attempt_at?: string | null
          recipient_id?: string | null
          rule_id?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_outbox_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_outbox_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "escalation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          owner_id: string | null
          status: Database["public"]["Enums"]["rag_status"]
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          owner_id?: string | null
          status?: Database["public"]["Enums"]["rag_status"]
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          owner_id?: string | null
          status?: Database["public"]["Enums"]["rag_status"]
        }
        Relationships: [
          {
            foreignKeyName: "projects_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      rag_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          department_id: string | null
          entity_id: string
          entity_type: string
          id: number
          new_status: Database["public"]["Enums"]["rag_status"]
          old_status: Database["public"]["Enums"]["rag_status"] | null
          project_id: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          department_id?: string | null
          entity_id: string
          entity_type: string
          id?: never
          new_status: Database["public"]["Enums"]["rag_status"]
          old_status?: Database["public"]["Enums"]["rag_status"] | null
          project_id?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          department_id?: string | null
          entity_id?: string
          entity_type?: string
          id?: never
          new_status?: Database["public"]["Enums"]["rag_status"]
          old_status?: Database["public"]["Enums"]["rag_status"] | null
          project_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rag_status_history_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rag_status_history_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          department_id: string | null
          generated_at: string
          generated_by: string | null
          id: string
          pdf_path: string
          period: Database["public"]["Enums"]["report_period"]
          period_end: string
          period_start: string
          project_id: string | null
          xlsx_path: string
        }
        Insert: {
          department_id?: string | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          pdf_path: string
          period: Database["public"]["Enums"]["report_period"]
          period_end: string
          period_start: string
          project_id?: string | null
          xlsx_path: string
        }
        Update: {
          department_id?: string | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          pdf_path?: string
          period?: Database["public"]["Enums"]["report_period"]
          period_end?: string
          period_start?: string
          project_id?: string | null
          xlsx_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      revisions: {
        Row: {
          baseline_id: string
          created_at: string
          created_by: string | null
          delta: Json
          id: string
        }
        Insert: {
          baseline_id: string
          created_at?: string
          created_by?: string | null
          delta: Json
          id?: string
        }
        Update: {
          baseline_id?: string
          created_at?: string
          created_by?: string | null
          delta?: Json
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "revisions_baseline_id_fkey"
            columns: ["baseline_id"]
            isOneToOne: false
            referencedRelation: "baselines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "revisions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          baseline_due_date: string | null
          baseline_start_date: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          rag_status: Database["public"]["Enums"]["rag_status"]
          start_date: string | null
          title: string
          workspace_id: string
        }
        Insert: {
          assignee_id?: string | null
          baseline_due_date?: string | null
          baseline_start_date?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          rag_status?: Database["public"]["Enums"]["rag_status"]
          start_date?: string | null
          title: string
          workspace_id: string
        }
        Update: {
          assignee_id?: string | null
          baseline_due_date?: string | null
          baseline_start_date?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          rag_status?: Database["public"]["Enums"]["rag_status"]
          start_date?: string | null
          title?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "department_workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      update_cycles: {
        Row: {
          closes_at: string
          created_at: string
          id: string
          opens_at: string
          status: string
        }
        Insert: {
          closes_at: string
          created_at?: string
          id?: string
          opens_at: string
          status?: string
        }
        Update: {
          closes_at?: string
          created_at?: string
          id?: string
          opens_at?: string
          status?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          department_id: string | null
          display_name: string | null
          email: string
          entra_oid: string | null
          id: string
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          created_at?: string
          department_id?: string | null
          display_name?: string | null
          email: string
          entra_oid?: string | null
          id: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          created_at?: string
          department_id?: string | null
          display_name?: string | null
          email?: string
          entra_oid?: string | null
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: [
          {
            foreignKeyName: "users_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      belongs_to_my_department: {
        Args: { p_workspace_id: string }
        Returns: boolean
      }
      budget_variance: {
        Args: never
        Returns: {
          actual_total: number
          budget_amount: number
          budget_id: string
          pct_used: number
          rag: Database["public"]["Enums"]["rag_status"]
          remaining: number
          workspace_id: string
        }[]
      }
      can_write: { Args: never; Returns: boolean }
      close_update_cycle: { Args: never; Returns: number }
      cumulative_threshold: {
        Args: { p_level: number; p_rule_id: string }
        Returns: string
      }
      current_department: { Args: never; Returns: string }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      cycle_non_submitters: {
        Args: { p_cycle_id: string }
        Returns: {
          department_id: string
          status: Database["public"]["Enums"]["update_status"]
          workspace_id: string
        }[]
      }
      due_escalations: {
        Args: { p_now?: string }
        Returns: {
          body: string
          dedup_key: string
          department_id: string
          level: number
          period_bucket: Database["public"]["Enums"]["escalation_period"]
          project_id: string
          recipient_id: string
          recipient_scope: Database["public"]["Enums"]["recipient_scope"]
          rule_id: string
          subject: string
          target_entity_id: string
          target_entity_type: string
        }[]
      }
      escalation_dispatch: { Args: { p_now?: string }; Returns: number }
      escalation_period_token: {
        Args: {
          p_at: string
          p_bucket: Database["public"]["Enums"]["escalation_period"]
        }
        Returns: string
      }
      escalation_recipient: {
        Args: {
          p_department_id: string
          p_member_hint?: string
          p_scope: Database["public"]["Enums"]["recipient_scope"]
        }
        Returns: string
      }
      is_director_or_executive: { Args: never; Returns: boolean }
      is_executive: { Args: never; Returns: boolean }
      lock_baseline: {
        Args: { p_name: string; p_project_id: string }
        Returns: {
          id: string
          locked_at: string
          locked_by: string | null
          name: string
          project_id: string
          snapshot: Json
        }
        SetofOptions: {
          from: "*"
          to: "baselines"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      open_update_cycle: { Args: never; Returns: string }
      outbox_mark_failed: {
        Args: { p_error: string; p_id: string; p_now?: string }
        Returns: undefined
      }
      outbox_send_batch: {
        Args: { p_limit?: number; p_now?: string }
        Returns: number
      }
      report_dispatch: { Args: { p_period: string }; Returns: undefined }
      resolve_escalations: { Args: { p_now: string }; Returns: undefined }
      resolve_scope: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: {
          department_id: string
          project_id: string
        }[]
      }
      task_in_my_department: { Args: { p_task_id: string }; Returns: boolean }
      week_cutoff: { Args: { p_at?: string }; Returns: string }
    }
    Enums: {
      audit_action:
        | "create"
        | "update"
        | "delete"
        | "approve"
        | "reject"
        | "lock"
      escalation_period: "iso_week" | "day"
      escalation_rule_type:
        | "late_update"
        | "red_lingering"
        | "blocked_dependency"
      notification_channel: "email" | "teams"
      notification_status: "queued" | "sent" | "failed"
      rag_status: "green" | "amber" | "red"
      recipient_scope: "member" | "director" | "executive"
      relation_type: "blocks" | "precedes" | "relates"
      report_period: "weekly" | "monthly"
      update_status: "draft" | "pending" | "approved" | "rejected"
      user_role: "executive" | "director" | "member" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      audit_action: ["create", "update", "delete", "approve", "reject", "lock"],
      escalation_period: ["iso_week", "day"],
      escalation_rule_type: [
        "late_update",
        "red_lingering",
        "blocked_dependency",
      ],
      notification_channel: ["email", "teams"],
      notification_status: ["queued", "sent", "failed"],
      rag_status: ["green", "amber", "red"],
      recipient_scope: ["member", "director", "executive"],
      relation_type: ["blocks", "precedes", "relates"],
      report_period: ["weekly", "monthly"],
      update_status: ["draft", "pending", "approved", "rejected"],
      user_role: ["executive", "director", "member", "viewer"],
    },
  },
} as const

