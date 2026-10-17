@id:catalog-search
Feature: Catalog search
  An agent searches the catalog of an instance before it calls anything.
  Search shows what the agent can call and what each call will do.
  It also finds upstream objects in the registry, and it never changes anything.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And agent 7 belongs to the admin and may read and write

  Rule: Search shows the operations the agent can call

    Scenario: An agent finds only the operations it can call
      Given the admin sets the group "lists" of "tasks" to read
      And the admin sets the group "tasks" of "tasks" to none
      When agent 7 searches the catalog of "tasks"
      Then agent 7 finds only "count the tasks", "show the open tasks" and "show the share password"

    Scenario: An agent can also see the operations that are off, with the reason
      Given the admin sets the group "lists" of "tasks" to read
      And the admin sets the group "tasks" of "tasks" to none
      When agent 7 searches the catalog of "tasks" and includes what is off
      Then agent 7 sees that "add a task" is off because its level is none
      And agent 7 sees that "delete a list" is off because the admin has not opted in

    Scenario: An agent never sees what its role keeps from it
      Given user 12 has the role "family", which has the instance "tasks"
      And agent 9 belongs to user 12 and may read and write
      And the admin sets the maximum of "family" for the group "lists" to read
      When agent 9 searches the catalog of "tasks" and includes what is off
      Then agent 9 finds only "count the tasks", "show the open tasks" and "show the share password"

  Rule: Search says what a call will do

    Scenario: A write in a group at level ask asks a human
      Given the admin sets the group "tasks" of "tasks" to ask
      When agent 7 looks up "add a task" in the catalog
      Then agent 7 reads that "add a task" asks a human first

    Scenario: An acknowledged write at level write runs without a question
      Given the admin sets the group "tasks" of "tasks" to write
      When agent 7 looks up "add a task" and "show the open tasks" in the catalog
      Then agent 7 reads that "add a task" runs without a question
      And agent 7 reads that "show the open tasks" runs at once

    Scenario: A session approval makes a write run without a question
      Given the admin approved the add of "butter" by agent 7 for this session
      When agent 7 looks up "add a task" in the catalog
      Then agent 7 reads that "add a task" runs without a question

  Rule: A read-only credential finds no writes

    Scenario: A read-only credential finds only reads
      Given the admin sets the group "tasks" of "tasks" to write
      And the admin gave agent 7 a read-only credential instead
      When agent 7 searches the catalog of "tasks"
      Then agent 7 finds only "count the tasks", "show the open tasks" and "show the share password"

  Rule: The group overview counts what each group holds

    Scenario: An agent sees the level and the counts of each group
      Given the admin sets the group "lists" of "tasks" to read
      And the admin gives "show the open tasks" its own level ask
      When agent 7 asks for the groups of "tasks"
      Then agent 7 sees the group "lists" at read with 3 reads, 2 writes, 1 locked, 0 to acknowledge and 1 own level

    Scenario: An agent of a role sees only the groups it can use
      Given user 12 has the role "family", which has the instance "tasks"
      And agent 9 belongs to user 12 and may read and write
      And the admin sets the maximum of "family" for the group "lists" to read
      When agent 9 asks for the groups of "tasks"
      Then agent 9 sees only the group "lists"

  Rule: Search reads the catalog only, and each search is recorded

    Scenario: Search code cannot change a list
      When the search code of agent 7 tries to add "butter" to "Groceries"
      Then agent 7 is told that search has no to-do functions
      And the list "Groceries" still holds the open tasks "milk", "bread" and "eggs"

    Scenario: Each search is recorded in the audit log
      When agent 7 searches the catalog of "tasks" twice
      Then the audit log shows 2 searches by agent 7

    Scenario: An agent reads the details of one operation
      When agent 7 asks for the details of "add a task" and of an operation that Acme does not have
      Then agent 7 reads that "add a task" takes a list and a title, with the summary "Add a task."
      And agent 7 gets no details for the operation that Acme does not have

  Rule: Search returns at most what the agent asks for

    Scenario: Search returns 50 operations when the agent gives no limit
      Given Acme has 260 saved views
      And the admin syncs "tasks"
      When agent 7 searches the catalog of "tasks"
      Then agent 7 finds 50 operations

    Scenario: Search returns 200 operations at most
      Given Acme has 260 saved views
      And the admin syncs "tasks"
      When agent 7 searches the catalog of "tasks" for up to 500 operations
      Then agent 7 finds 200 operations

  Rule: The registry finds only matching upstream objects

    Scenario: An agent finds the tasks of one list
      Given Acme also has the list "Chores" with the open task "dishes"
      And the admin syncs "tasks"
      When agent 7 looks in the registry for the tasks of "Groceries"
      Then agent 7 gets "bread", "eggs" and "milk"

    Scenario: A task removed in Acme is gone after a sync
      Given Acme removes "eggs" from "Groceries"
      And the admin syncs "tasks"
      When agent 7 looks in the registry for the tasks of "Groceries"
      Then agent 7 gets "bread" and "milk"

    Scenario: The registry hides the API token
      Given the list "Groceries" has the description "Synced with acme-tok-9f8e7d6c"
      And the admin syncs "tasks"
      When agent 7 looks in the registry for the list "Groceries"
      Then agent 7 reads the description "Synced with [REDACTED]"

  Rule: Registry search text is literal

    Scenario: A percent sign matches only itself
      Given Acme also has the list "Pantry" with the open tasks "100% juice" and "1000 grams of rice"
      And the admin syncs "tasks"
      When agent 7 searches the registry for "100%"
      Then agent 7 gets only "100% juice"

    Scenario: An underscore matches only itself
      When agent 7 searches the registry for "_a"
      Then agent 7 gets nothing

    Scenario: The admin cannot search with a malformed scope name
      When the admin searches the registry of "tasks" with the scope name "Bad Scope"
      Then the admin is told that "Bad Scope" is not a scope name

  Rule: The agent's app learns which tools change things

    Scenario: The app sees that search changes nothing and running code can destroy things
      When the app of agent 7 lists the tools of "tasks"
      Then the app sees that search changes nothing
      And the app sees that running code can change and destroy things

    Scenario: The app gets the plugin's agent instructions after core's own text
      Given the plugin of "tasks" ships the agent instructions "Name lists in title case."
      When agent 7 opens a session on "tasks"
      Then the app of agent 7 gets core's instructions, then "Name lists in title case."

    Scenario: Without plugin instructions the app gets core's text only
      When agent 7 opens a session on "tasks"
      Then the app of agent 7 gets only core's instructions
