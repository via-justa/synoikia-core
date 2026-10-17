@id:rate-limits
Feature: Rate limits
  Each credential has its own budget of runs and of writes on an instance.
  Only a few runs go at once on an instance.
  The admin sets the budgets in the settings of the instance.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And agent 7 belongs to the admin and may read and write
    And "tasks" allows each credential 2 writes a minute

  Rule: Each credential has a run budget

    Scenario: The third run in a minute is refused
      Given "tasks" allows each credential 2 runs a minute
      And agent 7 counted "Groceries" three times in one run, and searched the catalog once
      When agent 7 runs code that returns 1
      Then agent 7 is told that it made too many runs, and to slow down

    Scenario: Another credential has its own run budget
      Given "tasks" allows each credential 2 runs a minute
      And agent 7b belongs to the admin and may read and write
      And agent 7 used up its runs
      When agent 7b runs code that returns 1
      Then agent 7b gets the value 1

    Scenario: Two credentials with the same name have separate run budgets
      Given "tasks" allows each credential 2 runs a minute
      And agents 7 and 7b each have a credential of the admin named "Claude"
      And agent 7 used up its runs
      When agent 7b runs code that returns 1
      Then agent 7b gets the value 1

  Rule: The write budget counts only writes that run

    Scenario: Denied writes do not use the write budget
      Given the admin denied three adds of agent 7
      And the admin sets the group "tasks" of "tasks" to write
      And agent 7 added "butter" and "jam" to "Groceries"
      When agent 7 adds "honey" to "Groceries"
      Then agent 7 is told that it made too many writes, and to slow down

    Scenario: Another credential has its own write budget
      Given the admin sets the group "tasks" of "tasks" to write
      And agent 7 added "butter" and "jam" to "Groceries"
      And agent 7b belongs to the admin and may read and write
      When agent 7b adds "honey" to "Groceries"
      Then the list "Groceries" holds the open task "honey"

    Scenario: A session approval does not lift the write budget
      Given the admin approved the add of "butter" by agent 7 for this session
      And agent 7 added "jam" to "Groceries"
      When agent 7 adds "honey" to "Groceries"
      Then agent 7 is told that it made too many writes, and to slow down

  Rule: Only a few runs go at once

    Scenario: A fifth run while four wait on Acme is told that core is busy
      Given Acme takes 2 seconds to answer
      And agent 7 started four reads of "Groceries" that wait for Acme
      When agent 7 runs code that returns 1
      Then agent 7 is told that core is busy

    Scenario: Runs work again after the busy runs end
      Given Acme takes 1 second to answer
      And agent 7 started four reads of "Groceries" that wait for Acme
      And those four reads ended
      When agent 7 runs code that returns 1
      Then agent 7 gets the value 1

    Scenario: A run that waits for approval gives its place back
      Given agent 7b belongs to the admin and may read and write
      And agents 7 and 7b each wait for the admin to approve two adds
      When agent 7 runs code that returns 1
      Then agent 7 gets the value 1
