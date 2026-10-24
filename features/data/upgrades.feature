@id:upgrades
Feature: Upgrades
  Core keeps its data in one data file in the data directory.
  Each start brings the data file to the current release, and keeps what was in it.

  Rule: The data file keeps the data across a restart

    Scenario: A restart keeps the users, the roles and the instances
      Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
      And the admin made the user "user15@acme.example"
      When core restarts
      Then the admin still has the user "user15@acme.example" with the role "family", and the instance "tasks"

  Rule: An upgrade keeps Acme ID for a user who had a password and a link

    Scenario: User 30 keeps only Acme ID after the upgrade
      Given user 30 had a password and a linked Acme ID before the upgrade
      When the server starts on the new release
      Then user 30 signs in with Acme ID, and their old password no longer signs in

    Scenario: The upgrade is in the audit log
      Given user 30 had a password and a linked Acme ID before the upgrade
      When the server starts on the new release
      Then the audit log says that the upgrade removed the password of user 30, because the account signs in with Acme ID
